import { SPACE_LIMITS } from '@agentsync/contract';
import { and, asc, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { createDb } from './index';
import { hashSecret } from './machines';
import { space, spaceFile } from './schema';
import type { Env } from '../env';

export type SpaceRow = typeof space.$inferSelect;
export type SpaceFileRow = typeof spaceFile.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh Share Link token: 24 random bytes, 32 base64url characters (`shareTokenSchema`). */
export const newShareToken = () => base64url(crypto.getRandomValues(new Uint8Array(24)));
const newWriteToken = () => `asw_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;

/** Create an empty Space. The Write Token is returned here once; only its hash is stored. */
export async function createSpace(
  env: Pick<Env, 'DB'>,
  input: { userId: string; title: string; summary: string | null; expiresAt: Date | null },
): Promise<{ row: SpaceRow; writeToken: string }> {
  const writeToken = newWriteToken();
  const now = new Date();
  const [row] = await createDb(env).insert(space).values({
    id: crypto.randomUUID(),
    userId: input.userId,
    title: input.title,
    summary: input.summary,
    shareToken: newShareToken(),
    writeTokenHash: await hashSecret(writeToken),
    isPrivate: false,
    expiresAt: input.expiresAt,
    totalBytes: 0,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return { row: row!, writeToken };
}

/** A user's own Space; other users' Spaces look like they don't exist. */
export function getUserSpace(env: Pick<Env, 'DB'>, userId: string, spaceId: string) {
  return createDb(env).select().from(space).where(and(eq(space.id, spaceId), eq(space.userId, userId))).get();
}

export function getSpaceByShareToken(env: Pick<Env, 'DB'>, shareToken: string) {
  return createDb(env).select().from(space).where(eq(space.shareToken, shareToken)).get();
}

/** The Space a Write Token belongs to, or `undefined`. */
export async function getSpaceByWriteToken(env: Pick<Env, 'DB'>, writeToken: string) {
  return createDb(env).select().from(space).where(eq(space.writeTokenHash, await hashSecret(writeToken))).get();
}

/** Every Space of the user, newest first, with its file count. */
export function listUserSpaces(env: Pick<Env, 'DB'>, userId: string) {
  return createDb(env).select({
    row: space,
    fileCount: sql<number>`(SELECT count(*) FROM ${spaceFile} WHERE ${spaceFile.spaceId} = ${space.id})`,
  }).from(space).where(eq(space.userId, userId)).orderBy(desc(space.createdAt)).all();
}

/** Bytes the user's Spaces hold, every status counted. */
export async function userUsedBytes(env: Pick<Env, 'DB'>, userId: string) {
  const row = await createDb(env).select({ used: sql<number>`coalesce(sum(${space.totalBytes}), 0)` })
    .from(space).where(eq(space.userId, userId)).get();
  return row?.used ?? 0;
}

export function listSpaceFiles(env: Pick<Env, 'DB'>, spaceId: string) {
  return createDb(env).select().from(spaceFile).where(eq(spaceFile.spaceId, spaceId)).orderBy(asc(spaceFile.path)).all();
}

export function getSpaceFile(env: Pick<Env, 'DB'>, spaceId: string, path: string) {
  return createDb(env).select().from(spaceFile).where(and(eq(spaceFile.spaceId, spaceId), eq(spaceFile.path, path))).get();
}

/** Change a Space's settings (title, summary, expiry, private, Share Link). Bumps `updatedAt`. */
export async function updateSpaceRow(
  env: Pick<Env, 'DB'>,
  spaceId: string,
  changes: Partial<Pick<SpaceRow, 'title' | 'summary' | 'expiresAt' | 'isPrivate' | 'shareToken'>>,
) {
  const [row] = await createDb(env).update(space).set({ ...changes, updatedAt: new Date() })
    .where(eq(space.id, spaceId)).returning();
  return row;
}

/**
 * Delete the Space's rows (its files cascade). The caller deletes its R2 objects. With `expiredBefore`,
 * only if it is still due for purging then (not private, expired by that time), so a Space revived or
 * made private since it was picked is kept.
 */
export async function deleteSpaceRow(env: Pick<Env, 'DB'>, spaceId: string, options: { expiredBefore?: Date } = {}) {
  const due = options.expiredBefore && and(eq(space.isPrivate, false), lte(space.expiresAt, options.expiredBefore));
  const result = await createDb(env).delete(space).where(and(eq(space.id, spaceId), due)).run();
  return result.meta.changes > 0; // D1 counts the cascaded rows too.
}

/**
 * Record a file's new version, already written to R2 at `file.r2Key`, and move the Space's
 * `totalBytes` by the size difference, in one batch. Nothing changes unless the Space and the
 * user both stay inside their limits, checked against what D1 holds at that moment, so racing
 * uploads can't overshoot. Returns the replaced version's R2 key (`null` for a new file), or
 * `{ ok: false }` when a limit would be passed.
 */
export async function putSpaceFile(
  env: Pick<Env, 'DB'>,
  userId: string,
  file: Omit<SpaceFileRow, 'updatedAt'>,
): Promise<{ ok: true; replacedKey: string | null; updatedAt: Date } | { ok: false }> {
  const now = Date.now();
  const oldSize = 'coalesce((SELECT size FROM space_file WHERE space_id = ?1 AND path = ?2), 0)';
  const [old, grown, upserted] = await env.DB.batch([
    env.DB.prepare('SELECT r2_key FROM space_file WHERE space_id = ?1 AND path = ?2').bind(file.spaceId, file.path),
    env.DB.prepare(
      `UPDATE space SET total_bytes = total_bytes - ${oldSize} + ?3, updated_at = ?4
       WHERE id = ?1 AND total_bytes - ${oldSize} + ?3 <= ?5
         AND (SELECT sum(total_bytes) FROM space WHERE user_id = ?6) - ${oldSize} + ?3 <= ?7`,
    ).bind(file.spaceId, file.path, file.size, now, SPACE_LIMITS.spaceBytes, userId, SPACE_LIMITS.userBytes),
    // `changes()` is the row count of the UPDATE just before: the file is recorded only if it passed.
    env.DB.prepare(
      `INSERT INTO space_file (space_id, path, size, content_type, sha256, r2_key, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() = 1
       ON CONFLICT (space_id, path) DO UPDATE SET size = excluded.size, content_type = excluded.content_type,
         sha256 = excluded.sha256, r2_key = excluded.r2_key, updated_at = excluded.updated_at`,
    ).bind(file.spaceId, file.path, file.size, file.contentType, file.sha256, file.r2Key, now),
  ]);
  if (grown!.meta.changes !== 1 || upserted!.meta.changes !== 1) return { ok: false };
  const replaced = (old!.results as { r2_key: string }[])[0];
  return { ok: true, replacedKey: replaced?.r2_key ?? null, updatedAt: new Date(now) };
}

/** Remove a file's row and its size from the Space's `totalBytes`. Returns the removed row (for its R2 key). */
export async function deleteSpaceFile(env: Pick<Env, 'DB'>, spaceId: string, path: string) {
  const [, deleted] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE space SET total_bytes = total_bytes - coalesce((SELECT size FROM space_file WHERE space_id = ?1 AND path = ?2), 0),
         updated_at = ?3
       WHERE id = ?1 AND EXISTS (SELECT 1 FROM space_file WHERE space_id = ?1 AND path = ?2)`,
    ).bind(spaceId, path, Date.now()),
    env.DB.prepare('DELETE FROM space_file WHERE space_id = ?1 AND path = ?2 RETURNING r2_key').bind(spaceId, path),
  ]);
  return (deleted!.results as { r2_key: string }[])[0]?.r2_key ?? null;
}

/** When a Space that expired before this was due for purging at `now`. */
export const purgeCutoff = (now: Date) => new Date(now.getTime() - SPACE_LIMITS.graceDays * DAY_MS);

/** Spaces whose grace period ended by `now` (`spaceDeleteAt` passed), oldest first. */
export function spacesToPurge(env: Pick<Env, 'DB'>, now: Date, limit: number) {
  return createDb(env).select({ id: space.id }).from(space).where(and(
    eq(space.isPrivate, false),
    isNotNull(space.expiresAt),
    lte(space.expiresAt, purgeCutoff(now)),
  )).orderBy(asc(space.expiresAt)).limit(limit).all();
}

export async function countUserSpaces(env: Pick<Env, 'DB'>, userId: string) {
  const row = await createDb(env).select({ count: sql<number>`count(*)` }).from(space).where(eq(space.userId, userId)).get();
  return row?.count ?? 0;
}

export async function countSpaceFiles(env: Pick<Env, 'DB'>, spaceId: string) {
  const row = await createDb(env).select({ count: sql<number>`count(*)` }).from(spaceFile).where(eq(spaceFile.spaceId, spaceId)).get();
  return row?.count ?? 0;
}
