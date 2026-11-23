import type { Env } from '../env';

/** A new R2 key for a file of the Space. Every version gets its own, so a Space purges by its `<id>/` prefix. */
export const newObjectKey = (spaceId: string) => `${spaceId}/${crypto.randomUUID()}`;

/** Thrown by `readLimited` when the body passes `limit` bytes; `size` is how far it got. */
export class BodyTooLarge extends Error {
  constructor(readonly size: number) {
    super('Body too large.');
  }
}

/**
 * Read a request body of at most `limit` bytes into memory, stopping as soon as it passes the limit.
 * R2 needs a body of known length, and only a request's own untouched body has one, so a one-request
 * upload is read whole (at most `SPACE_LIMITS.partBytes`) to be hashed and then written. With
 * `expectedLength` (from `Content-Length`) the buffer is allocated once instead of joined from chunks.
 */
export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  expectedLength: number | null = null,
): Promise<Uint8Array<ArrayBuffer>> {
  let bytes = new Uint8Array(expectedLength !== null && expectedLength <= limit ? expectedLength : 0);
  let size = 0;
  const reader = body?.getReader();
  for (;;) {
    const read = await reader?.read();
    if (!read || read.done) break;
    const chunk = read.value;
    if (size + chunk.byteLength > limit) {
      await reader!.cancel();
      throw new BodyTooLarge(size + chunk.byteLength);
    }
    if (size + chunk.byteLength > bytes.byteLength) {
      const grown = new Uint8Array(Math.min(limit, Math.max(bytes.byteLength * 2, size + chunk.byteLength, 64 * 1024)));
      grown.set(bytes.subarray(0, size));
      bytes = grown;
    }
    bytes.set(chunk, size);
    size += chunk.byteLength;
  }
  return size === bytes.byteLength ? bytes : bytes.slice(0, size);
}

const hex = (digest: ArrayBuffer) => Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** The hex SHA-256 of the R2 object at `key`, streamed so a large file is never held whole; `null` if it is gone. */
export async function objectSha256(env: Pick<Env, 'SPACES_BUCKET'>, key: string) {
  const object = await env.SPACES_BUCKET.get(key);
  if (!object) return null;
  // The DOM lib's `Crypto` type wins over the Workers one, which has `DigestStream`.
  const workersCrypto = crypto as Crypto & { DigestStream: typeof DigestStream };
  const digest = new workersCrypto.DigestStream('SHA-256');
  await object.body.pipeTo(digest);
  return hex(await digest.digest);
}

/** Delete every R2 object under `prefix` (a Space's `<id>/`), a page of up to 1000 at a time. */
export async function deleteObjectsByPrefix(env: Pick<Env, 'SPACES_BUCKET'>, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await env.SPACES_BUCKET.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await env.SPACES_BUCKET.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
