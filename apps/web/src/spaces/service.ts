import {
  SPACE_LIMITS, SPACE_PUBLIC_ROUTES, spaceDeleteAt, spaceExpiresAt, spaceStatus,
  type CreatedSpace, type PublicSpace, type Space, type SpaceDetail, type SpaceErrorCode, type SpaceEvent,
  type SpaceExpiry, type SpaceFile,
} from '@agentsync/contract';
import { getAppOrigin } from '../auth';
import {
  countSpaceFiles, countUserSpaces, createSpace, deleteSpaceFile, deleteSpaceRow, getSpaceFile, getUserSpace, listSpaceFiles, listUserSpaces,
  newShareToken, purgeCutoff, putSpaceFile, spacesToPurge, updateSpaceRow, userUsedBytes,
  type SpaceFileRow, type SpaceRow,
} from '../db/spaces';
import type { Env } from '../env';
import { contentTypeFor } from './content-type';
import type { SpaceHub } from './hub';
import { spaceDigest } from './digest';
import { BodyTooLarge, deleteObjectsByPrefix, newObjectKey, readLimited, sha256Hex } from './storage';
import { zipStream } from './zip';

/** A Spaces failure with its contract code; the HTTP routes answer it as `{ error: { code, message } }`. */
export class SpaceError extends Error {
  constructor(readonly code: SpaceErrorCode, message: string) {
    super(message);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Spaces one user may have at once, whatever their size. */
const MAX_SPACES_PER_USER = 200;
/** Text files read for the digest are cut at this size. */
const DIGEST_READ_MAX_BYTES = 256 * 1024;

const toFile = (row: SpaceFileRow): SpaceFile => ({
  path: row.path, size: row.size, contentType: row.contentType, sha256: row.sha256, updatedAt: row.updatedAt,
});

/** Changes the owner (all of them) or the Write Token (no `private`) can make to a Space's settings. */
export interface SpaceChanges {
  title?: string | undefined;
  summary?: string | null | undefined;
  expires?: SpaceExpiry | undefined;
  private?: boolean | undefined;
}

/**
 * Everything Spaces do, for the oRPC procedures (`spaces.*`), the Write Token routes and the public
 * `/s/*` routes. Callers check who may act on a Space; this keeps D1, R2 and the `SpaceHub` in step.
 */
export function spacesService(env: Env) {
  const origin = getAppOrigin(env);

  function meta(row: SpaceRow, now = new Date()): Omit<PublicSpace, 'files'> {
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      status: spaceStatus(row, now),
      expiresAt: row.expiresAt,
      shareUrl: `${origin}${SPACE_PUBLIC_ROUTES.space(row.shareToken)}`,
      totalBytes: row.totalBytes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  const dashboard = (row: SpaceRow, fileCount: number): Space => ({ ...meta(row), deleteAt: spaceDeleteAt(row), fileCount });

  /**
   * Ask the Space's `SpaceHub` to tell its viewers about a change. Best effort: a Durable Object hiccup
   * is logged, never fails the write.
   */
  async function hub(spaceId: string, work: (stub: DurableObjectStub<SpaceHub>) => Promise<unknown>) {
    try {
      await work(env.SPACE_HUB.get(env.SPACE_HUB.idFromName(spaceId)));
    } catch (error) {
      console.error(`[spaces] SpaceHub of ${spaceId} failed:`, error);
    }
  }
  /** Send `event` to the viewers of an active Space; a private or expired one had them closed. */
  const broadcast = (row: SpaceRow, event: SpaceEvent) =>
    spaceStatus(row) === 'active' ? hub(row.id, (stub) => stub.broadcast(event)) : Promise.resolve();

  /**
   * Delete the Space's rows, then sweep its R2 prefix. Rows go first, so an upload still in flight
   * fails its D1 batch and deletes its own new object; anything it wrote before that, the sweep gets.
   * `expiredBefore` deletes only a Space still due for purging (see `deleteSpaceRow`).
   */
  async function destroy(spaceId: string, options: { expiredBefore?: Date } = {}) {
    if (!await deleteSpaceRow(env, spaceId, options)) return false;
    await deleteObjectsByPrefix(env, `${spaceId}/`);
    await hub(spaceId, (stub) => stub.close('deleted'));
    return true;
  }

  return {
    meta,

    async create(userId: string, input: { title: string; summary?: string | undefined; expires?: SpaceExpiry | undefined }): Promise<CreatedSpace> {
      const [used, count] = await Promise.all([userUsedBytes(env, userId), countUserSpaces(env, userId)]);
      if (used >= SPACE_LIMITS.userBytes) throw new SpaceError('QUOTA_EXCEEDED', 'Your Spaces use all your storage. Delete some first.');
      if (count >= MAX_SPACES_PER_USER) throw new SpaceError('QUOTA_EXCEEDED', `You can have at most ${MAX_SPACES_PER_USER} Spaces. Delete some first.`);
      const { row, writeToken } = await createSpace(env, {
        userId,
        title: input.title,
        summary: input.summary || null,
        expiresAt: spaceExpiresAt(input.expires ?? `${SPACE_LIMITS.defaultDays}d`),
      });
      return { space: { ...meta(row), files: [] }, writeToken };
    },

    async list(userId: string) {
      const [rows, usedBytes] = await Promise.all([listUserSpaces(env, userId), userUsedBytes(env, userId)]);
      return { spaces: rows.map(({ row, fileCount }) => dashboard(row, fileCount)), usedBytes, limitBytes: SPACE_LIMITS.userBytes };
    },

    async publicSpace(row: SpaceRow): Promise<PublicSpace> {
      return { ...meta(row), files: (await listSpaceFiles(env, row.id)).map(toFile) };
    },

    async detail(row: SpaceRow): Promise<SpaceDetail> {
      const files = (await listSpaceFiles(env, row.id)).map(toFile);
      return { ...dashboard(row, files.length), files };
    },

    async dashboard(row: SpaceRow) {
      return dashboard(row, await countSpaceFiles(env, row.id));
    },

    /**
     * Apply `changes`. Any `expires` revives an expired Space at the same Share Link. `private: false`
     * on a Space that has expired meanwhile gives it the default expiry, so it doesn't stay dark.
     */
    async update(row: SpaceRow, changes: SpaceChanges): Promise<SpaceRow> {
      const now = new Date();
      let expiresAt = changes.expires === undefined ? row.expiresAt : spaceExpiresAt(changes.expires, now);
      if (changes.private === false && changes.expires === undefined && expiresAt && expiresAt <= now) {
        expiresAt = new Date(now.getTime() + SPACE_LIMITS.defaultDays * DAY_MS);
      }
      const updated = await updateSpaceRow(env, row.id, {
        title: changes.title,
        summary: changes.summary === undefined ? undefined : changes.summary || null,
        expiresAt,
        isPrivate: changes.private,
      });
      if (!updated) throw new SpaceError('NOT_FOUND', 'No such Space.');
      // The `space` event also moves the hub's expiry alarm.
      if (updated.isPrivate && !row.isPrivate) await hub(row.id, (stub) => stub.close('private'));
      else await broadcast(updated, { type: 'space', space: meta(updated, now) });
      return updated;
    },

    /** Replace the Share Link. The old one stops working and its viewers are disconnected. */
    async rotateLink(row: SpaceRow) {
      const updated = await updateSpaceRow(env, row.id, { shareToken: newShareToken() });
      if (!updated) throw new SpaceError('NOT_FOUND', 'No such Space.');
      await hub(row.id, (stub) => stub.rotate(updated.shareToken));
      return updated;
    },

    async remove(row: SpaceRow) {
      if (!await destroy(row.id)) throw new SpaceError('NOT_FOUND', 'No such Space.');
    },

    /**
     * Store `body` as the file at `path` (already normalized), replacing any older version. Checks the
     * file, Space and user limits from `Content-Length` before reading, while reading, and once more in
     * D1. The new bytes go to a new R2 key before D1 points at them, and the old key is deleted only
     * after, so a failure never leaves a file without its bytes. `sha256` (if given) must match.
     */
    async putFile(
      row: SpaceRow,
      path: string,
      upload: { body: ReadableStream<Uint8Array> | null; contentType: string | null; contentLength: number | null; sha256: string | null },
    ): Promise<SpaceFile> {
      const [existing, used] = await Promise.all([getSpaceFile(env, row.id, path), userUsedBytes(env, row.userId)]);
      const oldSize = existing?.size ?? 0;
      const room = {
        file: SPACE_LIMITS.fileBytes,
        space: SPACE_LIMITS.spaceBytes - (row.totalBytes - oldSize),
        user: SPACE_LIMITS.userBytes - (used - oldSize),
      };
      const limitError = (size: number) =>
        size > room.file ? new SpaceError('FILE_TOO_LARGE', `A file may be at most ${SPACE_LIMITS.fileBytes / 1024 / 1024} MB.`)
          : size > room.space ? new SpaceError('SPACE_FULL', `A Space may hold at most ${SPACE_LIMITS.spaceBytes / 1024 / 1024} MB.`)
            : size > room.user ? new SpaceError('QUOTA_EXCEEDED', `Your Spaces may hold at most ${SPACE_LIMITS.userBytes / 1024 / 1024} MB.`)
              : null;
      if (upload.contentLength !== null) {
        const error = limitError(upload.contentLength);
        if (error) throw error;
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await readLimited(upload.body, Math.min(room.file, room.space, room.user), upload.contentLength);
      } catch (error) {
        if (error instanceof BodyTooLarge) throw limitError(error.size) ?? error;
        throw error;
      }
      const sha256 = await sha256Hex(bytes);
      if (upload.sha256 !== null && upload.sha256.toLowerCase() !== sha256) {
        throw new SpaceError('INVALID_REQUEST', 'X-Content-SHA256 does not match the uploaded bytes.');
      }
      const contentType = contentTypeFor(path, upload.contentType);
      const r2Key = newObjectKey(row.id);
      await env.SPACES_BUCKET.put(r2Key, bytes, { sha256, httpMetadata: { contentType } });
      const stored = await putSpaceFile(env, row.userId, { spaceId: row.id, path, size: bytes.byteLength, contentType, sha256, r2Key });
      if (!stored.ok) {
        await env.SPACES_BUCKET.delete(r2Key);
        // Another upload took the room meanwhile, or the Space is gone: say which limit it hits now.
        const [fresh, freshFile, nowUsed] = await Promise.all([
          getUserSpace(env, row.userId, row.id), getSpaceFile(env, row.id, path), userUsedBytes(env, row.userId),
        ]);
        if (!fresh) throw new SpaceError('NOT_FOUND', 'No such Space.');
        room.space = SPACE_LIMITS.spaceBytes - (fresh.totalBytes - (freshFile?.size ?? 0));
        room.user = SPACE_LIMITS.userBytes - (nowUsed - (freshFile?.size ?? 0));
        throw limitError(bytes.byteLength) ?? new SpaceError('QUOTA_EXCEEDED', 'A storage limit was reached.');
      }
      if (stored.replacedKey) {
        await env.SPACES_BUCKET.delete(stored.replacedKey).catch((error: unknown) => {
          console.error(`[spaces] could not delete ${stored.replacedKey}:`, error);
        });
      }
      const file: SpaceFile = { path, size: bytes.byteLength, contentType, sha256, updatedAt: stored.updatedAt };
      await broadcast(row, { type: 'file', file });
      return file;
    },

    async deleteFile(row: SpaceRow, path: string) {
      const r2Key = await deleteSpaceFile(env, row.id, path);
      if (!r2Key) throw new SpaceError('NOT_FOUND', 'No such file.');
      await env.SPACES_BUCKET.delete(r2Key);
      await broadcast(row, { type: 'fileDeleted', path });
    },

    /** The file's row and R2 object, or `null`. */
    async openFile(row: SpaceRow, path: string) {
      const file = await getSpaceFile(env, row.id, path);
      const object = file && await env.SPACES_BUCKET.get(file.r2Key);
      return file && object ? { file, object } : null;
    },

    async digest(row: SpaceRow) {
      const files = await listSpaceFiles(env, row.id);
      const keys = new Map(files.map((file) => [file.path, file.r2Key]));
      return spaceDigest({ ...meta(row), files: files.map(toFile) }, async (path) => {
        const object = await env.SPACES_BUCKET.get(keys.get(path)!, { range: { offset: 0, length: DIGEST_READ_MAX_BYTES } });
        return object ? object.text() : null;
      });
    },

    /** A store-mode ZIP of every file, streamed from R2 one file at a time. */
    async zip(row: SpaceRow) {
      const files = await listSpaceFiles(env, row.id);
      return zipStream(files.map((file) => ({ ...file, name: file.path, modified: file.updatedAt })), async (file) =>
        (await env.SPACES_BUCKET.get(file.r2Key))?.body ?? null);
    },

    /**
     * Purge up to `limit` Spaces whose grace period has ended. A Space revived or made private since it
     * was picked is kept; one that fails is logged and left for the next run. Returns how many went.
     */
    async purge(now: Date, limit: number) {
      let purged = 0;
      for (const { id } of await spacesToPurge(env, now, limit)) {
        try {
          if (await destroy(id, { expiredBefore: purgeCutoff(now) })) purged++;
        } catch (error) {
          console.error(`[spaces] could not purge ${id}:`, error);
        }
      }
      return purged;
    },
  };
}
