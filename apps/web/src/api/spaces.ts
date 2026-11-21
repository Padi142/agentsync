import {
  normalizeSpacePath, SPACE_ERROR_STATUS, shareTokenSchema, spaceStatus, spaceWriterUpdateSchema,
} from '@agentsync/contract';
import { Hono, type Context } from 'hono';
import { getSpaceByShareToken, getSpaceByWriteToken } from '../db/spaces';
import type { Env } from '../env';
import { isInertType } from '../spaces/content-type';
import { HUB_EXPIRES_AT_HEADER, HUB_SHARE_TOKEN_HEADER, HUB_STALE_TOKEN_STATUS } from '../spaces/hub-protocol';
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
 * The Space whose Write Token the request carries, if it is the one in the URL. With `write`, it must
 * not be expired: every mutation fails with `SPACE_EXPIRED` until the owner revives it.
 */
async function writer(c: SpaceContext, { write }: { write: boolean }) {
  const token = c.req.header('Authorization')?.match(/^Bearer (asw_\S+)$/i)?.[1];
  const row = token ? await getSpaceByWriteToken(c.env, token) : undefined;
  if (!row) throw new SpaceError('UNAUTHORIZED', 'A valid Write Token is required (Authorization: Bearer asw_…).');
  if (row.id !== c.req.param('id')) throw new SpaceError('NOT_FOUND', 'No such Space.');
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

const contentDisposition = (kind: 'inline' | 'attachment', path: string) =>
  `${kind}; filename*=UTF-8''${encodeURIComponent(path.slice(path.lastIndexOf('/') + 1))}`;

// Write Token routes.

spacesApi.get('/api/spaces/:id', async (c) => c.json(await spacesService(c.env).publicSpace(await writer(c, { write: false }))));

spacesApi.patch('/api/spaces/:id', async (c) => {
  const row = await writer(c, { write: true });
  const body = spaceWriterUpdateSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!body.success) throw new SpaceError('INVALID_REQUEST', body.error.issues[0]?.message ?? 'Invalid body.');
  const service = spacesService(c.env);
  return c.json(await service.publicSpace(await service.update(row, body.data)));
});

spacesApi.delete('/api/spaces/:id', async (c) => {
  await spacesService(c.env).remove(await writer(c, { write: true }));
  return c.body(null, 204);
});

const FILE_PREFIX = /^\/api\/spaces\/[^/]+\/files\//;

spacesApi.put('/api/spaces/:id/files/*', async (c) => {
  const row = await writer(c, { write: true });
  const path = pathIn(c, FILE_PREFIX);
  const length = c.req.header('Content-Length');
  const file = await spacesService(c.env).putFile(row, path, {
    body: c.req.raw.body,
    contentType: c.req.header('Content-Type') ?? null,
    contentLength: length && /^\d+$/.test(length) ? Number(length) : null,
    sha256: c.req.header('X-Content-SHA256') ?? null,
  });
  return c.json(file);
});

spacesApi.delete('/api/spaces/:id/files/*', async (c) => {
  const row = await writer(c, { write: true });
  await spacesService(c.env).deleteFile(row, pathIn(c, FILE_PREFIX));
  return c.body(null, 204);
});

// Public Share Link routes.

/** `/s/<token>` (by `Accept`: JSON, else the Markdown digest; browsers get the viewer before this), `.md`, `.json`. */
spacesApi.get('/s/:name', async (c) => {
  const [, token, suffix] = c.req.param('name').match(/^(.*?)(\.md|\.json)?$/)!;
  const row = await shared(c, token!);
  const accept = c.req.header('Accept') ?? '';
  const json = suffix === '.json' || (!suffix && accept.includes('application/json') && !accept.includes('text/markdown'));
  if (!suffix) c.header('Vary', 'Accept');
  const service = spacesService(c.env);
  if (json) return c.json(await service.publicSpace(row));
  return c.body(await service.digest(row), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

spacesApi.get('/s/:token/raw/*', async (c) => {
  const row = await shared(c, c.req.param('token'));
  const opened = await spacesService(c.env).openFile(row, pathIn(c, /^\/s\/[^/]+\/raw\//));
  if (!opened) throw new SpaceError('NOT_FOUND', 'No such file.');
  const { file, object } = opened;
  const headers: Record<string, string> = {
    'Content-Type': file.contentType,
    'Content-Length': String(object.size),
    ETag: object.httpEtag,
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': RAW_CSP,
  };
  if (!isInertType(file.contentType)) headers['Content-Disposition'] = contentDisposition('attachment', file.path);
  return c.body(object.body, 200, headers);
});

spacesApi.get('/s/:token/download.zip', async (c) => {
  const row = await shared(c, c.req.param('token'));
  const name = row.title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'space';
  return c.body(await spacesService(c.env).zip(row), 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition('attachment', `${name}.zip`),
    'Access-Control-Allow-Origin': '*',
  });
});

/**
 * Upgrade to the Space's `SpaceHub`, which sends `SpaceEvent`s until the Share Link stops working. The hub
 * is told which token was checked; if it knows another, either the link was rotated meanwhile (D1 now
 * says so: 404) or the hub missed a rotation (D1 still has this token: catch the hub up and retry once).
 */
spacesApi.get('/s/:token/ws', async (c) => {
  const row = await shared(c, c.req.param('token'));
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    throw new SpaceError('INVALID_REQUEST', 'Expected a WebSocket upgrade.');
  }
  const hub = c.env.SPACE_HUB.get(c.env.SPACE_HUB.idFromName(row.id));
  const forward = () => {
    const headers = new Headers(c.req.raw.headers);
    headers.set(HUB_SHARE_TOKEN_HEADER, row.shareToken);
    headers.set(HUB_EXPIRES_AT_HEADER, row.expiresAt ? String(row.expiresAt.getTime()) : 'never');
    return hub.fetch(new Request(c.req.raw, { headers }));
  };
  const response = await forward();
  if (response.status !== HUB_STALE_TOKEN_STATUS) return response;
  await shared(c, row.shareToken);
  await hub.rotate(row.shareToken);
  return forward();
});
