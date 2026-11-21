import {
  publicSpaceSchema, SPACE_LIMITS, SPACE_PUBLIC_ROUTES, SPACE_WRITER_ROUTES, spaceErrorSchema, spaceFileSchema,
  type SpaceErrorCode, type SpaceWriterUpdate,
} from '@agentsync/contract';
import type { z } from 'zod';
import { CliError, EXIT } from '../exit.js';
import type { Io } from '../io.js';

/**
 * The Spaces HTTP routes the CLI calls: the Write Token routes (`SPACE_WRITER_ROUTES`) and a Share Link's
 * public ones (`SPACE_PUBLIC_ROUTES`). Every answer is parsed with the contract's schemas, and every
 * `spaceErrorSchema` error becomes a `CliError` that says what happened and what to do.
 */

type Side = { kind: 'writer'; server: string; spaceId: string } | { kind: 'reader'; origin: string };

/** What to tell a person about a Space error `code`, and the exit code it gets. */
function explain(code: SpaceErrorCode, message: string, side: Side): { text: string; exit: (typeof EXIT)[keyof typeof EXIT] } {
  const site = side.kind === 'writer' ? side.server : side.origin;
  switch (code) {
    case 'UNAUTHORIZED':
      return {
        text: side.kind === 'writer'
          ? `Space ${side.spaceId} doesn't exist, or that isn't its Write Token. Pass the token from \`agentsync space create\` with --token or AGENTSYNC_SPACE_TOKEN.`
          : 'This Share Link needs no sign-in, but the server refused it.',
        exit: EXIT.auth,
      };
    case 'NOT_FOUND':
      return {
        text: side.kind === 'writer'
          ? `Not found: Space ${side.spaceId} or that file doesn't exist, or the Write Token is wrong.`
          : 'This Share Link doesn\'t open a Space: it was deleted, made private, or replaced with a new link.',
        exit: EXIT.error,
      };
    case 'SPACE_EXPIRED':
      return {
        text: side.kind === 'writer'
          ? `This Space has expired, so it can't be changed. Its owner can revive it at ${site}/spaces; the Share Link stays the same.`
          : `This Share Link has expired. The Space's owner can revive it at ${site}/spaces.`,
        exit: EXIT.error,
      };
    case 'FILE_TOO_LARGE':
      return { text: `${message} A Space file can be at most ${SPACE_LIMITS.fileBytes / 1024 / 1024} MB.`, exit: EXIT.error };
    case 'SPACE_FULL':
      return { text: `${message} A Space holds at most ${SPACE_LIMITS.spaceBytes / 1024 / 1024} MB.`, exit: EXIT.error };
    case 'QUOTA_EXCEEDED':
      return { text: `${message} Your Spaces can hold ${SPACE_LIMITS.userBytes / 1024 / 1024} MB in all; delete some at ${site}/spaces.`, exit: EXIT.error };
    case 'INVALID_PATH':
    case 'INVALID_REQUEST':
      return { text: message, exit: EXIT.error };
  }
}

/** Fetch `path` on `side`'s server, returning the response when it is a success and throwing otherwise. */
async function call(io: Io, side: Side, path: string, init: RequestInit = {}): Promise<Response> {
  const base = side.kind === 'writer' ? side.server : side.origin;
  const response = await io.fetch(`${base}${path}`, init);
  if (response.ok) return response;
  const body = spaceErrorSchema.safeParse(await response.json().catch(() => null));
  if (!body.success) throw new CliError(`The server answered ${response.status}.`, EXIT.error);
  const { code, message } = body.data.error;
  const { text, exit } = explain(code, message, side);
  throw new CliError(text, exit, { code });
}

/** `value` parsed with `schema`, or an error saying the server's answer can't be used. */
function parsed<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new CliError(`The server sent an answer this CLI can't use (${issue?.path.join('.') || 'body'}: ${issue?.message}). Nothing was changed for it.`, EXIT.error);
}

/** The Write Token routes of one Space. */
export function writerClient(io: Io, server: string, spaceId: string, token: string) {
  const side: Side = { kind: 'writer', server, spaceId };
  const send = (path: string, init: RequestInit = {}) =>
    call(io, side, path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  return {
    get: async () => parsed(publicSpaceSchema, await (await send(SPACE_WRITER_ROUTES.space(spaceId))).json()),
    update: async (update: SpaceWriterUpdate) => parsed(publicSpaceSchema, await (await send(SPACE_WRITER_ROUTES.space(spaceId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    })).json()),
    delete: async () => void await send(SPACE_WRITER_ROUTES.space(spaceId), { method: 'DELETE' }),
    /** Upload `bytes` as `path` (already normalized); the server checks them against `sha256`. */
    put: async (path: string, bytes: Uint8Array<ArrayBuffer>, contentType: string, sha256: string) =>
      parsed(spaceFileSchema, await (await send(SPACE_WRITER_ROUTES.file(spaceId, path), {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'X-Content-SHA256': sha256 },
        body: bytes,
      })).json()),
    remove: async (path: string) => void await send(SPACE_WRITER_ROUTES.file(spaceId, path), { method: 'DELETE' }),
  };
}

export type WriterClient = ReturnType<typeof writerClient>;

/** A Share Link's public routes. They need no account and no token. */
export function readerClient(io: Io, link: { origin: string; shareToken: string }) {
  const side: Side = { kind: 'reader', origin: link.origin };
  return {
    space: async () => parsed(publicSpaceSchema, await (await call(io, side, SPACE_PUBLIC_ROUTES.json(link.shareToken), {
      headers: { Accept: 'application/json' },
    })).json()),
    /** A file's bytes and type. `path` must already be normalized. */
    raw: async (path: string) => {
      const response = await call(io, side, SPACE_PUBLIC_ROUTES.raw(link.shareToken, path));
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('Content-Type') ?? 'application/octet-stream',
      };
    },
    /** The Space's WebSocket, for `pull --watch`. */
    socketUrl: `${link.origin.replace(/^http/, 'ws')}${SPACE_PUBLIC_ROUTES.ws(link.shareToken)}`,
  };
}

export type ReaderClient = ReturnType<typeof readerClient>;
