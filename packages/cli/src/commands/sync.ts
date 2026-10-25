import { isAbsolute } from 'node:path';
import type { SyncPayload } from '@agentsync/contract';
import { render, validate } from '@agentsync/template';
import type { Context, Outcome } from '../context.js';
import { CliError, describeError, EXIT } from '../exit.js';
import { choose, handOff } from '../handoff.js';
import { expandHome } from '../paths.js';
import { machineClient } from '../session.js';
import { backupPath, checkTarget, writeTarget } from '../targets.js';

/** How long a hook waits for the server before keeping the existing files. */
const HOOK_TIMEOUT_MS = 2000;

export type TargetResult = {
  path: string;
  agent: string;
  /** `drift` means it is still unresolved; `kept` and `handed-off` were a choice; `error` could not be read or written. */
  status: 'written' | 'unchanged' | 'overwritten' | 'kept' | 'handed-off' | 'drift' | 'error';
  diff?: string;
  error?: string;
};

function driftPrompt(path: string, diff: string): string {
  return `AgentSync found Drift in ${path}: it was edited by hand since AgentSync last wrote it.
Targets are Rendered output, so this change belongs in the Template (shared by every Machine)
or in this Machine's Variables. Use the agentsync skill.

The hand edit:

\`\`\`diff
${diff.trimEnd()}
\`\`\`

1. Run \`agentsync template --json\` to get the Template and its revision.
2. Put shared changes into the Template. For a change only this Machine needs, use an
   Expression such as \`{{if machine.name == "…"}}\` or a Variable (\`agentsync vars --var KEY=VALUE\`).
3. Save it with \`agentsync edit --file <file> --base <revision>\`.
4. Run \`agentsync sync --overwrite\` and check that ${path} now holds the change.`;
}

/**
 * Render the Template once per Target: the `agent` Built-in Variable differs from one to the
 * next. A Target whose path is not absolute (or `~/…`) is skipped with a warning, because it
 * would resolve against whichever directory the hook happens to run in.
 */
export function renderTargets(ctx: Context, { template, machine, variables }: SyncPayload) {
  const usable = machine.targets.filter((target) => {
    if (isAbsolute(expandHome(target.path, ctx.io))) return true;
    ctx.warn(`Skipped the Target "${target.path}": its path must be absolute or start with ~/.`);
    return false;
  });
  return usable.map((target) => {
    const { text, warnings } = render(template.text, {
      variables: variables.variables,
      builtins: { machine: { name: machine.name, os: machine.os }, agent: target.agent },
    });
    return { target, path: expandHome(target.path, ctx.io), rendered: text, warnings };
  });
}

/** Throw if the Template does not parse: the CLI never writes a Target from a broken Template. */
export function assertValid(text: string): void {
  const error = validate(text);
  if (error) {
    throw new CliError(
      `The Template has a syntax error at line ${error.line}, column ${error.column}: ${error.message}. Nothing was written.`,
      EXIT.error,
    );
  }
}

/**
 * Render the Template into every Target and write the ones that changed. Drift is resolved by
 * `--overwrite`/`--keep`, by asking at a terminal, or left in place (exit code 3).
 */
export async function applySync(ctx: Context, payload: SyncPayload): Promise<Outcome & { results: TargetResult[] }> {
  const { template } = payload;
  const results: TargetResult[] = [];
  const data = {
    templateRevision: template.revision,
    openConflicts: payload.openConflicts,
    missingVariables: [] as string[],
    targets: results,
  };
  if (template.revision === 0) {
    ctx.say('The account has no Template yet, so nothing was written.');
    return { data, results };
  }
  assertValid(template.text);

  const missing = new Set<string>();
  try {
    for (const { target, path, rendered, warnings } of renderTargets(ctx, payload)) {
      for (const warning of warnings) missing.add(warning.variable);
      const result: TargetResult = { path: target.path, agent: target.agent, status: 'unchanged' };
      results.push(result);
      try {
        const lastWritten = ctx.config.written[target.path];
        const check = checkTarget({ path, rendered, ...(lastWritten === undefined ? {} : { lastWritten }) });
        const write = (backup: boolean) => {
          writeTarget(path, rendered, { backup });
          ctx.config.written[target.path] = rendered;
        };

        if (check.status === 'missing' || check.status === 'stale') {
          write(false);
          result.status = 'written';
          ctx.say(`Wrote ${target.path}`);
        } else if (check.status === 'current') {
          ctx.config.written[target.path] = rendered;
        } else {
          result.diff = check.diff!;
          let choice = ctx.flags.overwrite ? 'overwrite' : ctx.flags.keep ? 'keep' : null;
          if (!choice && ctx.canAsk) {
            ctx.say(`\n${target.path} has Drift: it was edited by hand since AgentSync wrote it.\n\n${check.diff}`);
            choice = await choose(
              ctx,
              'Discard the hand edit and [o]verwrite, [k]eep it and skip, or hand it to an [a]gent? ',
              ['overwrite', 'keep', 'agent'],
            );
          }
          if (choice === 'overwrite') {
            write(true);
            result.status = 'overwritten';
            ctx.say(`Overwrote ${target.path} (the hand edit is in ${backupPath(target.path)})`);
          } else if (choice === 'keep') {
            result.status = 'kept';
            ctx.say(`Kept the hand edit in ${target.path}`);
          } else if (choice === 'agent') {
            await handOff(ctx, driftPrompt(target.path, check.diff!));
            result.status = 'handed-off';
          } else {
            result.status = 'drift';
            if (!ctx.flags.hook) {
              ctx.say(`\n${target.path} has Drift: it was edited by hand since AgentSync wrote it.\n\n${check.diff}`);
              ctx.say(
                'Run `agentsync sync --overwrite` to discard it (a backup is kept), `agentsync sync --keep` to leave it,\nor fold the change into the Template.',
              );
            }
          }
        }
      } catch (error) {
        // One Target that cannot be read or written must not stop the others.
        result.status = 'error';
        result.error = describeError(error);
        ctx.warn(`Could not write ${target.path}: ${result.error}`);
      }
    }
  } finally {
    // Remember what was written even if something later fails, or the next sync sees false Drift.
    ctx.save();
  }

  data.missingVariables = [...missing].sort();
  for (const name of data.missingVariables) {
    ctx.warn(`Variable "${name}" is not set on this Machine. Set it with \`agentsync vars --var ${name}=VALUE\`.`);
  }
  if (payload.openConflicts.count > 0 && !ctx.flags.hook) {
    ctx.warn(`${payload.openConflicts.count} open Conflict(s). Resolve them at ${payload.openConflicts.url}`);
  }
  const failed = results.some((result) => result.status === 'error');
  const drifted = results.some((result) => result.status === 'drift');
  return { code: failed ? EXIT.error : drifted ? EXIT.drift : EXIT.ok, data, results };
}

/**
 * `sync --hook <agent>`, run by an agent's SessionStart hook. It fails open: it never prompts,
 * waits at most ~2s for the server, keeps the existing files when offline, always exits 0, and
 * prints at most one line, which the agent adds to its context.
 */
async function hookSync(ctx: Context): Promise<Outcome> {
  const agent = ctx.flags.hook!;
  const parts: string[] = [];
  try {
    const payload = await machineClient(ctx, HOOK_TIMEOUT_MS).machines.sync();
    const { results, data } = await applySync(ctx, payload);
    const written = results.filter((result) => result.status === 'written');
    const own = written.filter((result) => result.agent === agent);
    const others = written.filter((result) => result.agent !== agent);
    if (own.length) {
      const paths = own.map((result) => result.path).join(', ');
      parts.push(
        `updated ${paths} to Template revision ${payload.template.revision}. This session loaded the previous version; read ${paths} for the current instructions`,
      );
    }
    if (others.length) parts.push(`updated ${others.map((result) => result.path).join(', ')}`);
    for (const result of results.filter((result) => result.status === 'error')) {
      parts.push(`could not write ${result.path}: ${result.error}`);
    }
    for (const result of results.filter((result) => result.status === 'drift')) {
      parts.push(`${result.path} has Drift (hand edited), so it was skipped; run \`agentsync sync\` to choose what to do`);
    }
    const missing = data!.missingVariables as string[];
    if (missing.length) parts.push(`Variables not set on this Machine: ${missing.join(', ')}`);
    if (payload.openConflicts.count > 0) {
      parts.push(`${payload.openConflicts.count} open Conflict(s), resolve at ${payload.openConflicts.url}`);
    }
  } catch (error) {
    parts.push(`kept the existing instructions: ${describeError(error)}`);
  }
  if (parts.length) ctx.io.out(`AgentSync: ${parts.map((part) => part.replace(/\.$/, '')).join('; ')}.`);
  return { code: EXIT.ok };
}

export async function sync(ctx: Context): Promise<Outcome> {
  if (ctx.flags.hook !== undefined) return hookSync(ctx);
  return applySync(ctx, await machineClient(ctx).machines.sync());
}
