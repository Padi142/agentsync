import type { Conflict, ContractClient } from '@agentsync/contract';
import { hasConflictMarkers, suspectedConflictMarkers, validate } from '@agentsync/template';
import { ORPCError } from '@orpc/client';
import type { Context, Outcome } from '../context.js';
import { CliError, EXIT, usage } from '../exit.js';
import { readText, writeText } from '../files.js';
import { expandHome } from '../paths.js';
import { machineClient } from '../session.js';

/** Why `text` cannot resolve a Conflict yet, or `null`. */
export function resolutionProblem(text: string): string | null {
  if (hasConflictMarkers(text)) return 'Conflict markers (<<<<<<<, |||||||, >>>>>>>) are still in the file.';
  const error = validate(text);
  return error ? `Syntax error at line ${error.line}, column ${error.column}: ${error.message}` : null;
}

/** Warn, without blocking, about lone `=======` lines: a leftover marker or a Markdown heading underline. */
export function warnSuspectedMarkers(ctx: Context, text: string): void {
  const lines = suspectedConflictMarkers(text);
  if (lines.length) {
    ctx.warn(
      `Warning: line ${lines.join(', ')} is exactly "=======". If that is a leftover Conflict marker, remove it; a Markdown heading underline is fine.`,
    );
  }
}

/**
 * Save `text` as the resolution of `conflict`. `base` is the Template revision it was merged
 * against: by default the one the marked text was built from (`serverRevision`), so a Template
 * change made since then is never overwritten silently.
 */
export async function resolveConflict(
  ctx: Context,
  client: ContractClient,
  conflict: Conflict,
  text: string,
  base = conflict.serverRevision,
): Promise<Outcome> {
  const problem = resolutionProblem(text);
  if (problem) throw new CliError(`${problem} Nothing was saved.`, EXIT.error);
  warnSuspectedMarkers(ctx, text);
  try {
    const { template } = await client.conflicts.resolve({ conflictId: conflict.id, text, expectedRevision: base });
    ctx.say(`Resolved Conflict ${conflict.id} as Template revision ${template.revision}. Run \`agentsync sync\` to apply it here.`);
    return { data: { conflict: { id: conflict.id, status: 'resolved' }, revision: template.revision } };
  } catch (error) {
    if (!(error instanceof ORPCError && error.code === 'CONFLICT')) throw error;
    throw new CliError(
      `The Template changed since this resolution was merged (it is now revision ${error.data.currentRevision}). ` +
        `Merge again with \`agentsync template\`, then pass --base ${error.data.currentRevision}, or use ${conflict.url}.`,
      EXIT.conflict,
      { conflict: { id: conflict.id, url: conflict.url }, currentRevision: error.data.currentRevision },
    );
  }
}

const summary = (conflict: Conflict) => ({
  id: conflict.id,
  url: conflict.url,
  baseRevision: conflict.baseRevision,
  serverRevision: conflict.serverRevision,
  createdAt: conflict.createdAt,
});

export function parseRevision(value: string | undefined, flag = '--base'): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw usage(`${flag} must be a revision number, not "${value}".`);
  return Number(value);
}

/** `conflict list | get <id> | resolve <id> <file>`. */
export async function conflict(ctx: Context): Promise<Outcome> {
  const [action, id, file] = ctx.args;
  const client = machineClient(ctx);
  if (action === 'list') {
    const conflicts = await client.conflicts.list();
    if (!conflicts.length) ctx.say('No open Conflicts.');
    for (const open of conflicts) ctx.say(`${open.id}  ${open.createdAt.toISOString()}  ${open.url}`);
    return { data: { conflicts: conflicts.map(summary) } };
  }
  if (action === 'get' && id) {
    const found = await client.conflicts.get({ conflictId: id });
    if (ctx.flags.out) {
      writeText(expandHome(ctx.flags.out, ctx.io), found.text);
      ctx.say(`Wrote Conflict ${id} to ${ctx.flags.out}. Fix it, then run \`agentsync conflict resolve ${id} ${ctx.flags.out}\`.`);
      return { data: { conflict: { ...summary(found), status: found.status } } };
    }
    if (!ctx.flags.json) ctx.io.out(found.text.replace(/\n$/, ''));
    return { data: { conflict: { ...summary(found), status: found.status, text: found.text } } };
  }
  if (action === 'resolve' && id && file) {
    const text = readText(expandHome(file, ctx.io));
    if (text === null) throw usage(`${file} does not exist.`);
    const found = await client.conflicts.get({ conflictId: id });
    if (found.status !== 'open') throw new CliError(`Conflict ${id} is already ${found.status}.`, EXIT.error);
    return resolveConflict(ctx, client, found, text, parseRevision(ctx.flags.base));
  }
  throw usage('Usage: agentsync conflict list | get <id> [--out <path>] | resolve <id> <file> [--base <revision>]');
}
