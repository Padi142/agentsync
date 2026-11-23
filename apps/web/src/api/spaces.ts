import {
  normalizeSpacePath, SPACE_ERROR_STATUS, SPACE_MAX_PARTS, shareTokenSchema, spaceStatus, spaceUploadCompleteSchema,
  spaceUploadStartSchema, spaceWriterUpdateSchema,
} from '@agentsync/contract';
import type { z } from 'zod';
import { Hono, type Context } from 'hono';
import { getSession } from '../auth';
import { getSpaceByShareToken, getSpaceByWriteToken, getUserSpace, type SpaceRow } from '../db/spaces';
import type { Env } from '../env';
import { isInertType } from '../spaces/content-type';
import { acceptQuality } from '../spaces/routing';
import { HUB_STALE_STATUS, HUB_STATE_HEADER, hubStateOf } from '../spaces/hub-protocol';
import { SpaceError, spacesService } from '../spaces/service';

type HonoEnv = { Bindings: Env };
type SpaceContext = Context<HonoEnv>;

/** Every raw file response: scripts in it can't run with the app's origin, even if opened directly. */
const RAW_CSP = "sandbox; default-src 'none'";

/**
 * The Spaces HTTP routes, beside oRPC because they stream raw bytes:
 * - Write Token routes under `/api/spaces/:id` (`SPACE_WRITER_ROUTES`). They read only the
 *   `Authorization: Bearer asw_…` header, never a cookie or a Machine token.
 * - Public Share Link routes under `/s/:token` (`SPACE_PUBLIC_ROUTES`). They need no credentials and set none.
 * Failures answer `{ error: { code, message } }` with the status in `SPACE_ERROR_STATUS`.
 */
export const spacesApi = new Hono<HonoEnv>();

spacesApi.onError((error, c) => {
  if (!(error instanceof SpaceError)) throw error;
  return c.json({ error: { code: error.code, message: error.message } }, SPACE_ERROR_STATUS[error.code]);
});

/**
 * The normalized Space path in the URL after `prefix` (a pattern ending at the path), each segment
 * URI-decoded. Anything that isn't already a normalized path (`..`, `%2e%2e`, null bytes, a leading
 * `/`, backslashes, empty segments) is rejected rather than cleaned up.
 */
function pathIn(c: SpaceContext, prefix: RegExp): string {
  const raw = new URL(c.req.url).pathname.replace(prefix, '');
  let path: string;
  try {
    path = raw.split('/').map(decodeURIComponent).join('/');
  } catch {
    throw new SpaceError('INVALID_PATH', 'The path is not valid URI encoding.');
  }
  if (normalizeSpacePath(path) !== path) throw new SpaceError('INVALID_PATH', 'Not a valid Space path.');
  return path;
}

/**
 * The Space whose Write Token the request carries, if it is the one in the URL (else `UNAUTHORIZED`). With `write`, it must
 * not be expired: every mutation fails with `SPACE_EXPIRED` until the owner revives it.
 */
async function writer(c: SpaceContext, { write }: { write: boolean }) {
  const token = c.req.header('Authorization')?.match(/^Bearer (asw_\S+)$/i)?.[1];
  const row = token ? await getSpaceByWriteToken(c.env, token) : undefined;
  // Another Space's token answers like a wrong one, so neither reveals whether the id exists.
  if (!row || row.id !== c.req.param('id')) {
    throw new SpaceError('UNAUTHORIZED', 'A valid Write Token for this Space is required (Authorization: Bearer asw_…).');
  }
  if (write && spaceStatus(row) === 'expired') {
    throw new SpaceError('SPACE_EXPIRED', 'This Space has expired. Its owner can revive it at /spaces.');
  }
  return row;
}

/** The Space a Share Link token opens: active only. Unknown and private look the same. */
async function shared(c: SpaceContext, token: string) {
  const row = shareTokenSchema.safeParse(token).success ? await getSpaceByShareToken(c.env, token) : undefined;
  if (!row || row.isPrivate) throw new SpaceError('NOT_FOUND', 'No such Space.');
  if (spaceStatus(row) === 'expired') throw new SpaceError('SPACE_EXPIRED', 'This Share Link has expired.');
  return row;
}

/**
 * The signed-in owner's Space, in any status (active, private or expired). Refuses any
 * `Authorization` header so Machine tokens and Write Tokens never reach owner routes.
 */
async function ownerSpace(c: SpaceContext): Promise<SpaceRow> {
  if (c.req.header('Authorization') !== undefined) {
    throw new SpaceError('UNAUTHORIZED', 'Use a browser session, not a token.');
  }
  const { user } = await getSession(c);
  if (!user) throw new SpaceError('UNAUTHORIZED', 'Sign in to open this Space.');
  const id = c.req.param('id');
  const row = id ? await getUserSpace(c.env, user.id, id) : undefined;
  if (!row) throw new SpaceError('NOT_FOUND', 'No such Space.');
  return row;
}

/** The request's JSON body parsed with `schema`, or `INVALID_REQUEST`. */
async function jsonBody<T extends z.ZodType>(c: SpaceContext, schema: T): Promise<z.output<T>> {
  const body = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!body.success) throw new SpaceError('INVALID_REQUEST', body.error.issues[0]?.message ?? 'Invalid body.');
  return body.data;
}

/** The request's `Content-Length`, or `null` without a valid one. */
function contentLength(c: SpaceContext) {
  const length = c.req.header('Content-Length');
  return length && /^\d+$/.test(length) ? Number(length) : null;
}

const contentDisposition = (kind: 'inline' | 'attachment', path: string) =>
  `${kind}; filename*=UTF-8''${encodeURIComponent(path.slice(path.lastIndexOf('/') + 1))}`;

async function rawFileResponse(c: SpaceContext, row: SpaceRow, path: string, { cors }: { cors: boolean }) {
  const opened = await spacesService(c.env).openFile(row, path);
  if (!opened) throw new SpaceError('NOT_FOUND', 'No such file.');
  const { file, object } = opened;
  const headers: Record<string, string> = {
    'Content-Type': file.contentType,
    'Content-Length': String(object.size),
    ETag: object.httpEtag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': RAW_CSP,
  };
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  if (!isInertType(file.contentType)) headers['Content-Disposition'] = contentDisposition('attachment', file.path);
  return c.body(object.body, 200, headers);
}

async function zipResponse(c: SpaceContext, row: SpaceRow, { cors }: { cors: boolean }) {
  const name = row.title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'space';
  const headers: Record<string, string> = {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition('attachment', `${name}.zip`),
  };
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  return c.body(await spacesService(c.env).zip(row), 200, headers);
}

// Write Token routes.

spacesApi.get('/api/spaces/:id', async (c) => c.json(await spacesService(c.env).publicSpace(await writer(c, { write: false }))));

spacesApi.patch('/api/spaces/:id', async (c) => {
  const row = await writer(c, { write: true });
  const body = await jsonBody(c, spaceWriterUpdateSchema);
  const service = spacesService(c.env);
  return c.json(await service.publicSpace(await service.update(row, body)));
});

spacesApi.delete('/api/spaces/:id', async (c) => {
  await spacesService(c.env).remove(await writer(c, { write: true }));
  return c.body(null, 204);
});

const FILE_PREFIX = /^\/api\/spaces\/[^/]+\/files\//;

spacesApi.put('/api/spaces/:id/files/*', async (c) => {
  const row = await writer(c, { write: true });
  const path = pathIn(c, FILE_PREFIX);
  const file = await spacesService(c.env).putFile(row, path, {
    body: c.req.raw.body,
    contentType: c.req.header('Content-Type') ?? null,
    contentLength: contentLength(c),
    sha256: c.req.header('X-Content-SHA256') ?? null,
  });
  return c.json(file);
});

spacesApi.delete('/api/spaces/:id/files/*', async (c) => {
  const row = await writer(c, { write: true });
  await spacesService(c.env).deleteFile(row, pathIn(c, FILE_PREFIX));
  return c.body(null, 204);
});

// Multipart uploads, for files over `SPACE_LIMITS.partBytes`.

spacesApi.post('/api/spaces/:id/uploads', async (c) => {
  const row = await writer(c, { write: true });
  return c.json(await spacesService(c.env).startUpload(row, await jsonBody(c, spaceUploadStartSchema)));
});

spacesApi.put('/api/spaces/:id/uploads/:upload/parts/:part', async (c) => {
  const row = await writer(c, { write: true });
  const part = c.req.param('part');
  const partNumber = /^\d{1,5}$/.test(part) ? Number(part) : 0;
  if (partNumber < 1 || partNumber > SPACE_MAX_PARTS) {
    throw new SpaceError('INVALID_REQUEST', `A part number is 1 to ${SPACE_MAX_PARTS}.`);
  }
  return c.json(await spacesService(c.env).uploadPart(row, c.req.param('upload'), partNumber, {
    body: c.req.raw.body,
    contentLength: contentLength(c),
  }));
});

spacesApi.post('/api/spaces/:id/uploads/:upload/complete', async (c) => {
  const row = await writer(c, { write: true });
  return c.json(await spacesService(c.env).completeUpload(row, c.req.param('upload'), await jsonBody(c, spaceUploadCompleteSchema)));
});

spacesApi.delete('/api/spaces/:id/uploads/:upload', async (c) => {
  // Allowed on an expired Space too, so a writer can always clean up.
  await spacesService(c.env).abortUpload(await writer(c, { write: false }), c.req.param('upload'));
  return c.body(null, 204);
});

// Owner session routes (active, private, and expired Spaces; no CORS).

spacesApi.get('/api/owner/spaces/:id/raw/*', async (c) => {
  const row = await ownerSpace(c);
  return rawFileResponse(c, row, pathIn(c, /^\/api\/owner\/spaces\/[^/]+\/raw\//), { cors: false });
});

spacesApi.get('/api/owner/spaces/:id/download.zip', async (c) => {
  const row = await ownerSpace(c);
  return zipResponse(c, row, { cors: false });
});

// Public Share Link routes.

/** `/s/<token>` (by `Accept`: JSON, else the Markdown digest; browsers get the viewer before this), `.md`, `.json`. */
spacesApi.on('GET', ['/s/:name', '/s/:name/'], async (c) => {
  const [, token, suffix] = c.req.param('name').match(/^(.*?)(\.md|\.json)?$/)!;
  const row = await shared(c, token!);
  const accept = c.req.header('Accept') ?? '';
  const json = suffix === '.json' || (!suffix && acceptQuality(accept, ['application/json']) > acceptQuality(accept, ['text/markdown']));
  if (!suffix) c.header('Vary', 'Accept');
  const service = spacesService(c.env);
  if (json) return c.json(await service.publicSpace(row));
  return c.body(await service.digest(row), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

spacesApi.get('/s/:token/raw/*', async (c) => {
  const row = await shared(c, c.req.param('token'));
  return rawFileResponse(c, row, pathIn(c, /^\/s\/[^/]+\/raw\//), { cors: true });
});

spacesApi.get('/s/:token/download.zip', async (c) => {
  const row = await shared(c, c.req.param('token'));
  return zipResponse(c, row, { cors: true });
});

/**
 * Upgrade to the Space's `SpaceHub`, which sends `SpaceEvent`s until the Share Link stops working. The hub
 * gets the Space's state as checked here; if it knows newer state, or that the link was turned off, D1 is
 * read again: a link rotated, made private, deleted or expired meanwhile fails like any other, and otherwise
 * the hub is caught up with the fresh state and the upgrade retried once.
 */
spacesApi.get('/s/:token/ws', async (c) => {
  let row = await shared(c, c.req.param('token'));
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    throw new SpaceError('INVALID_REQUEST', 'Expected a WebSocket upgrade.');
  }
  const hub = c.env.SPACE_HUB.get(c.env.SPACE_HUB.idFromName(row.id));
  const forward = () => {
    const headers = new Headers(c.req.raw.headers);
    headers.set(HUB_STATE_HEADER, JSON.stringify(hubStateOf(row)));
    return hub.fetch(new Request(c.req.raw, { headers }));
  };
  for (let attempt = 0; ; attempt++) {
    const response = await forward();
    if (response.status !== HUB_STALE_STATUS) return response;
    if (attempt === 1) throw new SpaceError('NOT_FOUND', 'No such Space.');
    row = await shared(c, row.shareToken);
  }
});
