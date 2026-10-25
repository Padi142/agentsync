import type { Conflict, ContractClient } from '@agentsync/contract';
import { validate } from '@agentsync/template';
import { ORPCError } from '@orpc/client';
import type { Context, Outcome } from '../context.js';
import { CliError, EXIT, usage } from '../exit.js';
import { readText } from '../files.js';
import { choose, handOff } from '../handoff.js';
import { expandHome } from '../paths.js';
import { readScratch, withScratchFile } from '../scratch.js';
import { machineClient } from '../session.js';
import { parseRevision, resolutionProblem, resolveConflict } from './conflict.js';

function conflictPrompt(conflict: Conflict): string {
  return `AgentSync could not save a Template edit: the Template changed since the edit began, so the
edit was kept as Conflict ${conflict.id}. Use the agentsync skill to resolve it.

1. Run \`agentsync conflict get ${conflict.id} --out <file>\`. It is the Template with git-style
   <<<<<<< ======= >>>>>>> markers around the lines both edits changed.
2. Merge both sides, keep every Expression valid, and remove all the marker lines.
3. Run \`agentsync conflict resolve ${conflict.id} <file>\`, then \`agentsync sync\`.

The person can also resolve it in the browser: ${conflict.url}`;
}

/** Open `file` in the editor until `problem` finds nothing wrong, or the person gives up (null). */
async function editUntil(ctx: Context, file: string, problem: (text: string) => string | null): Promise<string | null> {
  for (;;) {
    await ctx.io.edit(file);
    const text = readScratch(file);
    const found = problem(text);
    if (!found) return text;
    ctx.say(found);
    if ((await choose(ctx, '[e]dit again or [q]uit? ', ['edit', 'quit'])) === 'quit') return null;
  }
}

const syntaxProblem = (text: string) => {
  const error = validate(text);
  return error ? `The Template does not parse at line ${error.line}, column ${error.column}: ${error.message}` : null;
};

/** Save `text` as the revision after `base`. On `CONFLICT`, keep it on the server as a Conflict. */
async function save(client: ContractClient, text: string, base: number) {
  try {
    return { template: await client.template.put({ text, expectedRevision: base }) };
  } catch (error) {
    if (!(error instanceof ORPCError && error.code === 'CONFLICT')) throw error;
    return { conflict: await client.conflicts.create({ baseRevision: base, text }) };
  }
}

/** After a Conflict is kept: open the web resolver, fix it here, or hand it to an agent. */
async function offerResolution(ctx: Context, client: ContractClient, conflict: Conflict): Promise<Outcome> {
  const kept: Outcome = { code: EXIT.conflict, data: { conflict: { id: conflict.id, url: conflict.url } } };
  ctx.say(`The Template changed since you started editing, so your edit was kept as Conflict ${conflict.id}.`);
  const choice = await choose(ctx, 'Resolve it on the [w]eb, [f]ix it here, or hand it to an [a]gent? ', [
    'web',
    'fix',
    'agent',
  ]);
  if (choice === 'web') {
    ctx.say(`Open ${conflict.url}`);
    return kept;
  }
  if (choice === 'agent') {
    await handOff(ctx, conflictPrompt(conflict));
    const after = await client.conflicts.get({ conflictId: conflict.id });
    return after.status === 'open' ? kept : { data: { conflict: { id: conflict.id, status: after.status } } };
  }
  return withScratchFile(`conflict-${conflict.id}.md`, conflict.text, async (file) => {
    const text = await editUntil(ctx, file, resolutionProblem);
    if (text === null) {
      ctx.say(`Conflict ${conflict.id} is still open: ${conflict.url}`);
      return kept;
    }
    return resolveConflict(ctx, client, conflict, text);
  });
}

function conflictOutcome(ctx: Context, conflict: Conflict): Outcome {
  ctx.say(`The Template changed since --base, so the edit was kept as Conflict ${conflict.id}: ${conflict.url}`);
  return { code: EXIT.conflict, data: { conflict: { id: conflict.id, url: conflict.url } } };
}

export async function edit(ctx: Context): Promise<Outcome> {
  const client = machineClient(ctx);
  if (ctx.flags.file !== undefined) {
    const base = parseRevision(ctx.flags.base);
    if (base === undefined) throw usage('--file needs --base <revision>: the Template revision the file was edited from.');
    const text = readText(expandHome(ctx.flags.file, ctx.io));
    if (text === null) throw usage(`${ctx.flags.file} does not exist.`);
    const problem = syntaxProblem(text);
    if (problem) throw new CliError(`${problem}. Nothing was saved.`, EXIT.error);
    const saved = await save(client, text, base);
    if (saved.conflict) return conflictOutcome(ctx, saved.conflict);
    ctx.say(`Saved Template revision ${saved.template.revision}.`);
    return { data: { revision: saved.template.revision } };
  }

  if (!ctx.canAsk) throw usage('edit opens an editor. Without a terminal, use --file <path> --base <revision>.');
  const current = await client.template.get();
  return withScratchFile('AGENTS.md', current.text, async (file) => {
    const text = await editUntil(ctx, file, syntaxProblem);
    if (text === null || text === current.text) {
      ctx.say('No changes saved.');
      return { data: { revision: current.revision } };
    }
    const saved = await save(client, text, current.revision);
    if (saved.conflict) return offerResolution(ctx, client, saved.conflict);
    ctx.say(`Saved Template revision ${saved.template.revision}. Run \`agentsync sync\` to apply it here.`);
    return { data: { revision: saved.template.revision } };
  });
}
