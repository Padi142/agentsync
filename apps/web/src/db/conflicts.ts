import type { Conflict } from '@agentsync/contract';
import { and, asc, count, eq } from 'drizzle-orm';
import { getAppOrigin } from '../auth';
import { markConflicts } from '../merge';
import { createDb } from './index';
import { conflict } from './schema';
import { getTemplate, putTemplate, templateRevisionText } from './templates';
import type { Env } from '../env';

type ConflictRow = typeof conflict.$inferSelect;

/** Where the web merge UI lists open Conflicts. */
export function conflictsUrl(env: Env) {
  return `${getAppOrigin(env)}/conflicts`;
}

function toConflict(env: Env, row: ConflictRow): Conflict {
  return {
    id: row.id,
    baseRevision: row.baseRevision,
    serverRevision: row.serverRevision,
    text: row.text,
    status: row.status,
    url: `${conflictsUrl(env)}/${row.id}`,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
  };
}

export async function countOpenConflicts(env: Pick<Env, 'DB'>, userId: string) {
  const row = await createDb(env).select({ n: count() }).from(conflict)
    .where(and(eq(conflict.userId, userId), eq(conflict.status, 'open'))).get();
  return row?.n ?? 0;
}

/**
 * Keep an edit that lost to the current Template, merged into one text with markers.
 * `null` if `baseRevision` is not in the user's history, or there is no Template yet
 * (an edit cannot have lost to the empty revision 0).
 */
export async function createConflict(env: Env, userId: string, baseRevision: number, edit: string) {
  const [current, base] = await Promise.all([
    getTemplate(env, userId),
    baseRevision === 0 ? { text: '' } : templateRevisionText(env, userId, baseRevision),
  ]);
  if (!base || current.revision === 0 || baseRevision > current.revision) return null;
  const row: ConflictRow = {
    id: crypto.randomUUID(),
    userId,
    baseRevision,
    serverRevision: current.revision,
    text: markConflicts(
      base.text,
      { text: current.text, label: `Template revision ${current.revision}` },
      { text: edit, label: `edit from revision ${baseRevision}` },
    ),
    status: 'open',
    createdAt: new Date(),
    closedAt: null,
  };
  await createDb(env).insert(conflict).values(row).run();
  return toConflict(env, row);
}

/** Open Conflicts, oldest first. */
export async function listOpenConflicts(env: Env, userId: string) {
  const rows = await createDb(env).select().from(conflict)
    .where(and(eq(conflict.userId, userId), eq(conflict.status, 'open')))
    .orderBy(asc(conflict.createdAt)).all();
  return rows.map((row) => toConflict(env, row));
}

export async function getConflict(env: Env, userId: string, conflictId: string) {
  const row = await createDb(env).select().from(conflict)
    .where(and(eq(conflict.id, conflictId), eq(conflict.userId, userId))).get();
  return row && toConflict(env, row);
}

/**
 * Save `text` as the next Template revision and mark the Conflict resolved, in one batch.
 * The save requires the Conflict to still be open and the head to be `expectedRevision`;
 * the caller validates `text`. Fails with the reason if either check does not hold.
 */
export async function resolveConflict(
  env: Env,
  userId: string,
  conflictId: string,
  text: string,
  expectedRevision: number,
) {
  const result = await putTemplate(env, userId, text, expectedRevision, {
    guard: {
      sql: "EXISTS (SELECT 1 FROM conflict WHERE id = ? AND user_id = ? AND status = 'open')",
      params: [conflictId, userId],
    },
    // Runs only when the save moved the head; otherwise the batch rolls back or changes nothing.
    after: (revision, at) => [env.DB.prepare(
      `UPDATE conflict SET status = 'resolved', closed_at = ?
       WHERE id = ? AND status = 'open' AND EXISTS (SELECT 1 FROM template WHERE user_id = ? AND revision = ?)`,
    ).bind(at.getTime(), conflictId, userId, revision)],
  });
  const closed = await getConflict(env, userId, conflictId);
  if (result.ok) return { ok: true as const, conflict: closed!, template: result.template };
  if (closed?.status !== 'open') return { ok: false as const, reason: 'not_found' as const };
  return { ok: false as const, reason: 'conflict' as const, currentRevision: result.currentRevision };
}

/** Close an open Conflict without saving it. `undefined` if it is not open. */
export async function discardConflict(env: Env, userId: string, conflictId: string) {
  const [row] = await createDb(env).update(conflict)
    .set({ status: 'discarded', closedAt: new Date() })
    .where(and(eq(conflict.id, conflictId), eq(conflict.userId, userId), eq(conflict.status, 'open')))
    .returning();
  return row && toConflict(env, row);
}
