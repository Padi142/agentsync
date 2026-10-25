import { isAbsolute } from 'node:path';
import type { SyncPayload } from '@agentsync/contract';
import { render, validate } from '@agentsync/template';
import type { Context, Outcome } from '../context.js';
import { CliError, describeError, EXIT, isCancelled } from '../exit.js';
import { handOff } from '../handoff.js';
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
   Expression such as \`{{if machine.nickname == "…"}}\` or a Variable (\`agentsync vars --var KEY=VALUE\`).
3. Save it with \`agentsync edit --file <file> --base <revision>\`.
4. Run \`agentsync sync --overwrite\` and check that ${path} now holds the change.`;
}

type DriftChoice = 'keep' | 'review' | 'agent' | 'overwrite';

/** Ask what to do about a Drifted Target. "Review changes" shows the diff and asks again. */
async function askAboutDrift(ctx: Context, path: string, diff: string): Promise<Exclude<DriftChoice, 'review'>> {
  ctx.io.err(ctx.paint.err.attention(`Drift in ${path}`));
  for (;;) {
    const choice = await ctx.select<DriftChoice>(
      'This Target was edited by hand. What should happen?',
      [
        { value: 'keep', label: 'Keep the hand edit and skip this Target' },
        { value: 'review', label: 'Review changes' },
        { value: 'agent', label: 'Ask an agent to update the Template' },
        { value: 'overwrite', label: 'Replace with the Template; keep a backup' },
      ],
      'keep',
    );
    if (choice !== 'review') return choice;
    ctx.io.out(diff.trimEnd());
  }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** One line with the outcome: what was updated, what was already current, and what was skipped or failed. */
function summarise(ctx: Context, revision: number, results: TargetResult[]): void {
  const count = (...statuses: TargetResult['status'][]) => results.filter((result) => statuses.includes(result.status)).length;
  const updated = count('written', 'overwritten');
  const current = count('unchanged');
  const skipped = count('kept', 'handed-off', 'drift');
  const failed = count('error');
  if (!skipped && !failed) {
    if (!updated) ctx.success(`All ${plural(current, 'Target')} ${current === 1 ? 'is' : 'are'} up to date · Template revision ${revision}`);
    else ctx.success(`Synced Template revision ${revision} · ${plural(updated, 'Target')} updated, ${current} already current`);
    return;
  }
  const parts = [`${updated} updated`, `${current} already current`, `${skipped} skipped`, `${failed} failed`];
  if (!ctx.flags.json) ctx.warn(`Template revision ${revision} · ${parts.join(', ')}`);
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
      builtins: {
        machine: { hostname: machine.hostname, nickname: machine.nickname, os: machine.os },
        agent: target.agent,
      },
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
          ctx.detail(`Wrote ${target.path}`);
        } else if (check.status === 'current') {
          ctx.config.written[target.path] = rendered;
        } else {
          result.diff = check.diff!;
          let choice: DriftChoice | null = ctx.flags.overwrite ? 'overwrite' : ctx.flags.keep ? 'keep' : null;
          if (!choice && ctx.canAsk) choice = await askAboutDrift(ctx, target.path, check.diff!);
          if (choice === 'overwrite') {
            write(true);
            result.status = 'overwritten';
            ctx.say(`Replaced ${target.path} with the Template; the hand edit is in ${backupPath(target.path)}`);
          } else if (choice === 'keep') {
            result.status = 'kept';
            ctx.say(`Kept the hand edit in ${target.path} and skipped it`);
          } else if (choice === 'agent') {
            await handOff(ctx, driftPrompt(target.path, check.diff!));
            result.status = 'handed-off';
          } else {
            result.status = 'drift';
            ctx.warn(`Drift in ${target.path}: it was edited by hand since AgentSync wrote it, so it was left alone.`);
            if (ctx.flags.verbose && !ctx.flags.json) ctx.io.err(check.diff!.trimEnd());
            ctx.warn(
              'Run `agentsync sync --overwrite` to replace it (a backup is kept), `agentsync sync --keep` to leave it, or fold the change into the Template.',
            );
          }
        }
      } catch (error) {
        // A Ctrl+C stops the whole sync; the `finally` below still remembers what was written.
        if (isCancelled(error)) throw error;
        // One Target that cannot be read or written must not stop the others.
        result.status = 'error';
        result.error = describeError(error);
        ctx.warn(`Could not write ${target.path}: ${result.error}`);
      }
    }
  } catch (error) {
    const updated = results.filter((result) => result.status === 'written' || result.status === 'overwritten').length;
    if (isCancelled(error) && updated) {
      throw new CliError(`Cancelled after updating ${plural(updated, 'Target')}.`, EXIT.cancelled);
    }
    throw error;
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
  summarise(ctx, template.revision, results);
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
  /** Once Targets may have been written, a failure must not claim the old files were kept. */
  let writing = false;
  try {
    const payload = await machineClient(ctx, HOOK_TIMEOUT_MS).machines.sync();
    writing = true;
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
    const outcome = writing ? 'sync failed; some Targets may have been updated' : 'kept the existing instructions';
    parts.push(`${outcome}: ${describeError(error)}`);
  }
  if (parts.length) ctx.io.out(`AgentSync: ${parts.map((part) => part.replace(/\.$/, '')).join('; ')}.`);
  return { code: EXIT.ok };
}

export async function sync(ctx: Context): Promise<Outcome> {
  if (ctx.flags.hook !== undefined) return hookSync(ctx);
  const payload = await ctx.during('Fetching the Template…', () => machineClient(ctx).machines.sync());
  return applySync(ctx, payload);
}
