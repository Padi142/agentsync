/**
 * Templates and Variable maps share one storage shape: a head row holding the current
 * revision, plus immutable revision rows numbered 1, 2, 3, … per owner.
 */
const stores = {
  template: { head: 'template', history: 'template_revision', key: 'user_id', payload: 'text' },
  variables: { head: 'machine_variables', history: 'machine_variables_revision', key: 'machine_id', payload: 'variables' },
} as const;

export type RevisionStore = keyof typeof stores;

/** A condition the head update also requires, e.g. that a Conflict is still open. */
export interface Guard {
  sql: string;
  params: unknown[];
}

export type RevisionWrite =
  | { ok: true; revision: number; at: Date }
  | { ok: false; currentRevision: number };

/**
 * Save `payload` as revision `expectedRevision + 1`, if the head is still at `expectedRevision`.
 *
 * The head update and the revision insert run in one D1 batch (a transaction). The insert
 * copies its revision number from the head row, so it only writes when this batch moved the
 * head. If another write won, the batch either changes nothing or hits the revision's
 * primary key and rolls back. `after` adds statements to the same batch; guard them on the
 * new head if they must only apply when the save does.
 */
export async function writeRevision(
  db: D1Database,
  store: RevisionStore,
  owner: string,
  payload: string,
  expectedRevision: number,
  options: { guard?: Guard; after?: (revision: number, at: Date) => D1PreparedStatement[] } = {},
): Promise<RevisionWrite> {
  const { head, history, key, payload: column } = stores[store];
  const revision = expectedRevision + 1;
  const at = new Date();
  const guard = options.guard ?? { sql: '1', params: [] };
  const moveHead = expectedRevision === 0
    ? db.prepare(`INSERT INTO ${head} (${key}, revision, updated_at) SELECT ?, 1, ? WHERE ${guard.sql} ON CONFLICT DO NOTHING`)
      .bind(owner, at.getTime(), ...guard.params)
    : db.prepare(`UPDATE ${head} SET revision = ?, updated_at = ? WHERE ${key} = ? AND revision = ? AND ${guard.sql}`)
      .bind(revision, at.getTime(), owner, expectedRevision, ...guard.params);
  const insertRevision = db.prepare(
    `INSERT INTO ${history} (${key}, revision, ${column}, created_at)
     SELECT ${key}, revision, ?, ? FROM ${head} WHERE ${key} = ? AND revision = ?`,
  ).bind(payload, at.getTime(), owner, revision);

  try {
    const [moved] = await db.batch([moveHead, insertRevision, ...(options.after?.(revision, at) ?? [])]);
    if (moved.meta.changes === 1) return { ok: true, revision, at };
  } catch (error) {
    if (!String(error).includes('UNIQUE constraint failed')) throw error;
  }
  return { ok: false, currentRevision: await headRevision(db, store, owner) };
}

/** The current head revision, or 0 if nothing has been saved. */
export async function headRevision(db: D1Database, store: RevisionStore, owner: string) {
  const { head, key } = stores[store];
  const row = await db.prepare(`SELECT revision FROM ${head} WHERE ${key} = ?`).bind(owner).first<{ revision: number }>();
  return row?.revision ?? 0;
}
