import type { Conflict, ContractClient } from '@agentsync/contract';
import { validate } from '@agentsync/template';
import { ORPCError } from '@orpc/client';
import type { Context, Outcome } from '../context.js';
import { CliError, EXIT, usage } from '../exit.js';
import { readText } from '../files.js';
import { handOff } from '../handoff.js';
import { expandHome } from '../paths.js';
import { readDraft, withDraft } from '../drafts.js';
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
    const text = readDraft(file);
    const found = problem(text);
    if (!found) return text;
    ctx.warn(found);
    const next = await ctx.select(
      'What now?',
      [
        { value: 'edit', label: 'Edit again' },
        { value: 'discard', label: 'Discard edit', hint: 'your changes are lost' },
      ],
      'edit',
    );
    if (next === 'discard') return null;
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
  const choice = await ctx.select(
    'How do you want to resolve it?',
    [
      { value: 'web', label: 'Resolve it in the browser', hint: conflict.url },
      { value: 'fix', label: 'Fix it here in the editor' },
      { value: 'agent', label: 'Ask an agent to resolve it' },
    ],
    'web',
  );
  if (choice === 'web') {
    ctx.say(`Open ${conflict.url}`);
    return kept;
  }
  if (choice === 'agent') {
    await handOff(ctx, conflictPrompt(conflict));
    const after = await client.conflicts.get({ conflictId: conflict.id });
    return after.status === 'open' ? kept : { data: { conflict: { id: conflict.id, status: after.status } } };
  }
  const recovery = (file: string) =>
    `Resolve it with \`agentsync conflict resolve ${conflict.id} ${file} --base ${conflict.serverRevision}\`.`;
  return withDraft(ctx, `conflict-${conflict.id}.md`, conflict.text, recovery, async (file) => {
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
    const saved = await ctx.during('Saving…', () => save(client, text, base));
    if (saved.conflict) return conflictOutcome(ctx, saved.conflict);
    ctx.success(`Saved Template revision ${saved.template.revision}`);
    return { data: { revision: saved.template.revision } };
  }

  if (!ctx.canAsk) throw usage('edit opens an editor. Without a terminal, use --file <path> --base <revision>.');
  const current = await ctx.during('Fetching the Template…', () => client.template.get());
  const base = current.revision;
  const recovery = (file: string) => `Save it with \`agentsync edit --file ${file} --base ${base}\`.`;
  // Once saved, as a revision or as a Conflict, the edit is safe on the server and the draft goes.
  const saved = await withDraft(ctx, 'AGENTS.md', current.text, recovery, async (file) => {
    const text = await editUntil(ctx, file, syntaxProblem);
    return text === null || text === current.text ? null : save(client, text, base);
  });
  if (!saved) {
    ctx.say('No changes saved.');
    return { data: { revision: base } };
  }
  if (saved.conflict) return offerResolution(ctx, client, saved.conflict);
  ctx.success(`Saved Template revision ${saved.template.revision} · run \`agentsync sync\` to apply it here`);
  return { data: { revision: saved.template.revision } };
}
