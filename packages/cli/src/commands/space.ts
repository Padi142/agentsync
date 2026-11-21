import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { normalizeSpacePath, parseShareUrl, spaceExpirySchema, type PublicSpace, type SpaceExpiry, type SpaceFile } from '@agentsync/contract';
import { normaliseServer } from '../client.js';
import type { Context, Outcome } from '../context.js';
import { CliError, describeError, EXIT, exitCodeFor, usage } from '../exit.js';
import { expandHome } from '../paths.js';
import { machineClient } from '../session.js';
import { readerClient, writerClient, type ReaderClient, type WriterClient } from '../spaces/http.js';
import {
  checkLimits, contentTypeFor, formatBytes, isText, localHash, localPath, removeLocal, sha256, walkDirectory, writeLocal, type LocalFile,
} from '../spaces/local.js';
import { watchSpace, type ClosedReason } from '../spaces/watch.js';

/** The flags only `space` reads; the shared ones are on `Context`. */
export interface SpaceFlags {
  title?: string;
  summary?: string;
  expires?: string;
  token?: string;
  watch: boolean;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Files moved at once, so a directory of small files doesn't upload one round-trip at a time. */
const PARALLEL = 4;

/** `work` on every item, `PARALLEL` at a time, results in order. */
async function inPool<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return results;
}

/** The positional arguments of `space <action>`: between `min` and `max` of them, or a usage error. */
function argsOf(ctx: Context, min: 0, max: 1): [string?];
function argsOf(ctx: Context, min: 1, max: 1): [string];
function argsOf(ctx: Context, min: 2, max: 2): [string, string];
function argsOf(ctx: Context, min: 2, max: 3): [string, string, string?];
function argsOf(ctx: Context, min: number, max: number): (string | undefined)[] {
  const [action = '', ...args] = ctx.args;
  if (args.length < min || args.length > max) {
    throw usage(`Usage: ${isAction(action) ? USAGE[action] : 'agentsync space'}\nRun agentsync help space ${action} for more.`);
  }
  return args;
}

/** A `--expires` value, checked. */
function expiryOf(value: string | undefined): SpaceExpiry | undefined {
  if (value === undefined) return undefined;
  const parsed = spaceExpirySchema.safeParse(value);
  if (!parsed.success) throw usage(`--expires takes a number of days such as 7d (at most 365d), or never; not "${value}".`);
  return parsed.data;
}

/** A Space path from the command line, normalized. */
function remotePathOf(value: string): string {
  const path = normalizeSpacePath(value);
  if (path === null) throw usage(`"${value}" can't be a path in a Space: use a relative path without "..".`);
  return path;
}

/** The server the Write Token routes are on: `--server`, else the one this Machine registered with. */
function serverOf(ctx: Context): string {
  if (ctx.flags.server) {
    const server = normaliseServer(ctx.flags.server);
    if (!server) throw usage(`--server must be an http(s) URL, not "${ctx.flags.server}".`);
    return server;
  }
  if (ctx.config.server) return ctx.config.server;
  throw usage('Pass --server <url>: this Machine is not registered with an AgentSync server.');
}

/**
 * A client for one Space's Write Token routes. The token comes from `--token` or `AGENTSYNC_SPACE_TOKEN`
 * and is never written anywhere.
 */
function writerFor(ctx: Context, flags: SpaceFlags, spaceId: string): WriterClient {
  const token = flags.token ?? ctx.io.env.AGENTSYNC_SPACE_TOKEN;
  if (!token) {
    throw new CliError('Changing a Space needs its Write Token: pass --token <token> or set AGENTSYNC_SPACE_TOKEN.', EXIT.auth);
  }
  return writerClient(ctx.io, serverOf(ctx), spaceId, token);
}

/** A client for a Share Link's public routes. It needs no config, account or token. */
function readerFor(ctx: Context, url: string): ReaderClient {
  const link = parseShareUrl(url);
  if (!link) throw usage(`"${url}" isn't a Share Link: expected https://<server>/s/<token>.`);
  return readerClient(ctx.io, link);
}

/** The files to upload from `path`: the file itself (as its name), or everything under a directory. */
async function filesAt(ctx: Context, path: string): Promise<LocalFile[]> {
  const abs = resolve(expandHome(path, ctx.io));
  const info = await stat(abs).catch(() => null);
  if (!info) throw usage(`No such file or directory: ${path}`);
  if (info.isFile()) return [{ path: remotePathOf(basename(abs)), abs, size: info.size }];
  if (!info.isDirectory()) throw usage(`${path} is neither a file nor a directory.`);
  const { files, skipped } = await walkDirectory(abs);
  if (skipped.length) ctx.warn(`Skipped ${plural(skipped.length, 'symlink or unusual name')}: ${skipped.join(', ')}`);
  return files;
}

/** Upload `files`, each with its type and SHA-256 taken from the bytes actually sent. */
function upload(ctx: Context, client: WriterClient, files: readonly Pick<LocalFile, 'path' | 'abs'>[]): Promise<SpaceFile[]> {
  return inPool(files, async ({ path, abs }) => {
    const bytes = new Uint8Array(await readFile(abs));
    const file = await client.put(path, bytes, contentTypeFor(path), sha256(bytes));
    ctx.detail(`Uploaded ${path} (${formatBytes(file.size)})`);
    return file;
  });
}

const describeExpiry = (space: Pick<PublicSpace, 'status' | 'expiresAt'>) =>
  space.status === 'private' ? 'Private: the Share Link is off'
    : space.status === 'expired' ? `Expired ${space.expiresAt?.toISOString().slice(0, 10)}`
      : space.expiresAt ? `Expires ${space.expiresAt.toISOString().slice(0, 10)}` : 'Permanent';

/** `space create [path]`: a new Space from this Machine, with `path` uploaded, and its Write Token shown once. */
async function create(ctx: Context, flags: SpaceFlags): Promise<Outcome> {
  const [path] = argsOf(ctx, 0, 1);
  const title = flags.title ?? (path === undefined ? undefined : basename(resolve(expandHome(path, ctx.io))));
  if (!title) throw usage('Pass --title <title>, or a file or directory to upload (its name is the default title).');
  const expires = expiryOf(flags.expires);
  const files = path === undefined ? [] : await filesAt(ctx, path);
  checkLimits(files);

  const machine = machineClient(ctx);
  const { space: created, writeToken } = await ctx.during('Creating the Space…', () =>
    machine.spaces.create({ title, ...(flags.summary ? { summary: flags.summary } : {}), ...(expires ? { expires } : {}) }));
  const client = writerClient(ctx.io, serverOf(ctx), created.id, writeToken);
  const show = (space: PublicSpace) => {
    ctx.say(`Share Link   ${space.shareUrl}`);
    ctx.say(`Space id     ${space.id}`);
    ctx.say(`Write Token  ${writeToken}`);
    ctx.warn(
      'The Write Token is shown only now and isn\'t saved anywhere. Pass it to change this Space later, with --token or AGENTSYNC_SPACE_TOKEN:\n' +
        `  AGENTSYNC_SPACE_TOKEN=${writeToken} agentsync space push ${space.id} <dir>`,
    );
  };

  let space = created;
  if (files.length) {
    try {
      await ctx.during(`Uploading ${plural(files.length, 'file')}…`, () => upload(ctx, client, files));
      space = await client.get();
    } catch (error) {
      show(created);
      throw new CliError(`Created the Space, but uploading failed: ${describeError(error)} Retry with \`agentsync space push\`.`, exitCodeFor(error), {
        space: created,
        writeToken,
      });
    }
  }
  ctx.success(`Created Space "${space.title}"${files.length ? ` with ${plural(files.length, 'file')} (${formatBytes(space.totalBytes)})` : ''}`);
  show(space);
  return { data: { space, writeToken } };
}

/** `space put <id> <local-file> [remote-path]`: upload one file. */
async function put(ctx: Context, flags: SpaceFlags): Promise<Outcome> {
  const [spaceId, local, remote] = argsOf(ctx, 2, 3);
  const abs = resolve(expandHome(local, ctx.io));
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) throw usage(`Not a file: ${local}`);
  const path = remotePathOf(remote ?? basename(abs));
  checkLimits([{ path, size: info.size }]);
  const [file] = await ctx.during(`Uploading ${path}…`, () => upload(ctx, writerFor(ctx, flags, spaceId), [{ path, abs }]));
  ctx.success(`Uploaded ${path} (${formatBytes(file!.size)})`);
  return { data: { file } };
}

/**
 * `space push <id> <local-dir>`: make the Space hold exactly the directory. Files whose SHA-256 already
 * matches are skipped; remote files missing locally are deleted, after a confirmation unless `--yes`
 * or `--json`. Deletions go first, so replacing files never needs room for both.
 */
async function push(ctx: Context, flags: SpaceFlags): Promise<Outcome> {
  const [spaceId, dir] = argsOf(ctx, 2, 2);
  const root = resolve(expandHome(dir, ctx.io));
  if (!(await stat(root).catch(() => null))?.isDirectory()) throw usage(`Not a directory: ${dir}`);
  const client = writerFor(ctx, flags, spaceId);
  const [space, files] = await ctx.during('Comparing…', async () => {
    const [space, { files, skipped }] = await Promise.all([client.get(), walkDirectory(root)]);
    if (skipped.length) ctx.warn(`Skipped ${plural(skipped.length, 'symlink or unusual name')}: ${skipped.join(', ')}`);
    // Before reading anything, so a huge file fails fast instead of filling memory.
    checkLimits(files);
    const hashed = await inPool(files, async (file) => ({ ...file, sha256: sha256(await readFile(file.abs)) }));
    return [space, hashed] as const;
  });

  const remote = new Map(space.files.map((file) => [file.path, file.sha256]));
  const local = new Set(files.map((file) => file.path));
  const uploads = files.filter((file) => remote.get(file.path) !== file.sha256);
  const unchanged = files.filter((file) => remote.get(file.path) === file.sha256).map((file) => file.path);
  const deletions = space.files.map((file) => file.path).filter((path) => !local.has(path));

  for (const file of uploads) ctx.detail(`  ${remote.has(file.path) ? 'change' : 'add   '}  ${file.path}`);
  if (deletions.length) {
    ctx.say(`Remote files not in ${dir}, to delete:\n${deletions.map((path) => `  ${path}`).join('\n')}`);
    if (!ctx.flags.yes && !ctx.flags.json) {
      if (!ctx.canAsk) throw usage(`push would delete ${plural(deletions.length, 'file')} from the Space. Pass --yes to delete them.`);
      const answer = await ctx.select(`Delete ${plural(deletions.length, 'file')} from "${space.title}"?`, [
        { value: 'yes', label: 'Delete them and push' },
        { value: 'no', label: 'Cancel' },
      ], 'no');
      if (answer === 'no') throw new CliError('Cancelled. Nothing was changed.', EXIT.cancelled);
    }
  }

  await ctx.during('Pushing…', async () => {
    await inPool(deletions, async (path) => {
      await client.remove(path);
      ctx.detail(`Deleted ${path}`);
    });
    await upload(ctx, client, uploads);
  });
  const changed = [uploads.length && `${uploads.length} uploaded`, deletions.length && `${deletions.length} deleted`].filter(Boolean);
  ctx.success(changed.length ? `Pushed ${dir}: ${changed.join(', ')}, ${unchanged.length} unchanged` : `"${space.title}" already matches ${dir}`);
  return { data: { uploaded: uploads.map((file) => file.path), deleted: deletions, unchanged } };
}

/** `space rm <id> <remote-path>`: delete one file. */
async function rm(ctx: Context, flags: SpaceFlags): Promise<Outcome> {
  const [spaceId, remote] = argsOf(ctx, 2, 2);
  const path = remotePathOf(remote);
  await ctx.during(`Deleting ${path}…`, () => writerFor(ctx, flags, spaceId).remove(path));
  ctx.success(`Deleted ${path}`);
  return { data: { deleted: path } };
}

/** `space update <id>`: change the title, summary or expiry. `--summary ""` clears the summary. */
async function update(ctx: Context, flags: SpaceFlags): Promise<Outcome> {
  const [spaceId] = argsOf(ctx, 1, 1);
  const expires = expiryOf(flags.expires);
  if (flags.title === undefined && flags.summary === undefined && !expires) {
    throw usage('Pass what to change: --title, --summary or --expires.');
  }
  const space = await ctx.during('Updating the Space…', () => writerFor(ctx, flags, spaceId).update({
    ...(flags.title !== undefined ? { title: flags.title } : {}),
    ...(flags.summary !== undefined ? { summary: flags.summary.trim() || null } : {}),
    ...(expires ? { expires } : {}),
  }));
  ctx.success(`Updated "${space.title}" · ${describeExpiry(space)}`);
  return { data: { space } };
}

/** `space delete <id>`: delete the Space, its files and its Share Link, after a confirmation unless `--yes`. */
async function deleteSpace(ctx: Context, flags: SpaceFlags): Promise<Outcome> {
  const [spaceId] = argsOf(ctx, 1, 1);
  const client = writerFor(ctx, flags, spaceId);
  if (!ctx.flags.yes) {
    if (!ctx.canAsk) throw usage(`Pass --yes to delete Space ${spaceId} and its Share Link.`);
    const space = await client.get();
    const answer = await ctx.select(`Delete "${space.title}", its ${plural(space.files.length, 'file')} and its Share Link?`, [
      { value: 'yes', label: 'Delete it' },
      { value: 'no', label: 'Cancel' },
    ], 'no');
    if (answer === 'no') throw new CliError('Cancelled. Nothing was changed.', EXIT.cancelled);
  }
  await ctx.during('Deleting the Space…', () => client.delete());
  ctx.success(`Deleted Space ${spaceId}`);
  return { data: { deleted: spaceId } };
}

/** `space inspect <url>`: a Space's metadata and file list. `--json` gives it as `publicSpaceSchema` in `space`. */
async function inspect(ctx: Context): Promise<Outcome> {
  const [url] = argsOf(ctx, 1, 1);
  const space = await ctx.during('Reading the Space…', () => readerFor(ctx, url).space());
  ctx.say(ctx.paint.out.bold(space.title));
  if (space.summary) ctx.say(space.summary);
  ctx.say(`${describeExpiry(space)} · ${plural(space.files.length, 'file')} · ${formatBytes(space.totalBytes)}`);
  ctx.say(space.shareUrl);
  const width = Math.max(0, ...space.files.map((file) => file.path.length));
  for (const file of space.files) {
    ctx.say(`  ${file.path.padEnd(width)}  ${formatBytes(file.size).padStart(8)}  ${file.contentType}`);
  }
  return { data: { space } };
}

/**
 * `space get <url> <remote-path> [--out <path>]`: one file. With `--out` it is saved there (into it, if
 * that's a directory). Without, a text file is printed to stdout (in `text` with `--json`); a binary one
 * needs `--out`.
 */
async function get(ctx: Context): Promise<Outcome> {
  const [url, remote] = argsOf(ctx, 2, 2);
  const path = remotePathOf(remote);
  const reader = readerFor(ctx, url);
  const space = await ctx.during('Reading the Space…', () => reader.space());
  const file = space.files.find((candidate) => candidate.path === path);
  if (!file) throw new CliError(`"${space.title}" has no file ${path}. Run agentsync space inspect ${url} to list its files.`, EXIT.error);
  const out = ctx.flags.out === undefined ? undefined : resolve(expandHome(ctx.flags.out, ctx.io));
  if (out === undefined && !isText(file.contentType)) {
    throw usage(`${path} is ${file.contentType}, not text. Pass --out <path> to save it.`);
  }
  const { bytes } = await ctx.during(`Downloading ${path}…`, () => reader.raw(path));
  const summary = { path, size: bytes.length, contentType: file.contentType };
  if (out === undefined) {
    const text = new TextDecoder().decode(bytes);
    if (!ctx.flags.json) ctx.io.out(text.replace(/\n$/, ''));
    return { data: { file: summary, text } };
  }
  const target = (await stat(out).catch(() => null))?.isDirectory() ? join(out, basename(path)) : out;
  await writeFile(target, bytes);
  ctx.success(`Saved ${path} to ${target} (${formatBytes(bytes.length)})`);
  return { data: { file: summary, out: target } };
}

const CLOSED: Record<ClosedReason, string> = {
  deleted: 'the Space was deleted',
  private: 'its owner made the Space private',
  expired: 'the Share Link expired',
  rotated: 'the Share Link was replaced with a new one',
};

/**
 * `space pull <url> <local-dir> [--watch]`: download every file whose SHA-256 differs from the local copy.
 * `--watch` then follows the Space live: it applies `file` and `fileDeleted` events, resyncs after a
 * reconnect (removing files it pulled that are gone), and stops on `closed` or Ctrl+C. Local files the
 * Space never had are left alone.
 */
async function pull(ctx: Context, flags: SpaceFlags): Promise<Outcome> {
  const [url, dir] = argsOf(ctx, 2, 2);
  const reader = readerFor(ctx, url);
  const root = resolve(expandHome(dir, ctx.io));
  /** Paths this pull wrote or found up to date: the only local files it may remove. */
  const known = new Set<string>();
  const downloaded: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];

  /** Bring `file` up to date locally; whether it was downloaded. */
  const fetchFile = async (file: Pick<SpaceFile, 'path' | 'sha256'>) => {
    known.add(file.path);
    if ((await localHash(root, file.path)) === file.sha256) return false;
    const { bytes } = await reader.raw(file.path);
    await writeLocal(root, file.path, bytes);
    downloaded.push(file.path);
    return true;
  };
  const remove = async (path: string) => {
    if (!known.delete(path)) return;
    await removeLocal(root, path);
    removed.push(path);
    ctx.say(`Removed ${path}`);
  };
  /** Match the Space as it is now. `prune` also removes the files pulled earlier that it no longer has. */
  const resync = async (prune: boolean) => {
    const space = await reader.space();
    // Check every path before writing any.
    for (const file of space.files) localPath(root, file.path);
    const before = new Set(known);
    const fresh = await inPool(space.files, fetchFile);
    for (const [index, file] of space.files.entries()) {
      if (fresh[index]) ctx.detail(`Downloaded ${file.path}`);
      else if (!prune) unchanged.push(file.path);
    }
    if (prune) {
      const now = new Set(space.files.map((file) => file.path));
      for (const path of before) if (!now.has(path)) await remove(path);
    }
    return { space, fresh: fresh.filter(Boolean).length };
  };

  const { space, fresh } = await ctx.during('Pulling…', () => resync(false));
  ctx.success(`Pulled "${space.title}" into ${dir}: ${fresh} downloaded, ${space.files.length - fresh} unchanged`);
  const data = { space: { id: space.id, title: space.title, shareUrl: space.shareUrl }, dir: root, downloaded, unchanged, removed };
  if (!flags.watch) return { data };

  ctx.say('Watching for changes; press Ctrl+C to stop.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  let closed: ClosedReason | null;
  try {
    closed = await watchSpace({
      url: reader.socketUrl,
      signal: controller.signal,
      sleep: (ms) => ctx.io.sleep(ms),
      warn: (text) => ctx.warn(text),
      resync: async () => {
        const { fresh } = await resync(true);
        if (fresh) ctx.say(`Caught up: ${plural(fresh, 'file')} downloaded`);
      },
      apply: async (event) => {
        if (event.type === 'fileDeleted') return remove(event.path);
        if (event.type === 'space') return ctx.detail(`The Space changed: "${event.space.title}" · ${describeExpiry(event.space)}`);
        try {
          if (await fetchFile(event.file)) ctx.say(`Updated ${event.file.path}`);
        } catch (error) {
          // Deleted again before we fetched it: its `fileDeleted` event follows.
          if (!(error instanceof CliError && error.details.code === 'NOT_FOUND')) throw error;
        }
      },
    });
  } finally {
    process.off('SIGINT', stop);
  }
  if (closed) ctx.warn(`Stopped watching: ${CLOSED[closed]}.`);
  else ctx.say('Stopped watching.');
  return { data: { ...data, ...(closed ? { closed } : {}) } };
}

/** Each action's usage line, for errors and help. */
export const USAGE = {
  create: 'agentsync space create [path] [--title <title>] [--summary <text>] [--expires <n>d|never]',
  put: 'agentsync space put <id> <local-file> [remote-path] --token <write-token>',
  push: 'agentsync space push <id> <local-dir> --token <write-token>',
  rm: 'agentsync space rm <id> <remote-path> --token <write-token>',
  update: 'agentsync space update <id> [--title <title>] [--summary <text>] [--expires <n>d|never] --token <write-token>',
  delete: 'agentsync space delete <id> --token <write-token>',
  inspect: 'agentsync space inspect <share-link>',
  get: 'agentsync space get <share-link> <remote-path> [--out <path>]',
  pull: 'agentsync space pull <share-link> <local-dir> [--watch]',
} as const;

const isAction = (action: string): action is keyof typeof USAGE => Object.hasOwn(USAGE, action);

const ACTIONS: Record<keyof typeof USAGE, (ctx: Context, flags: SpaceFlags) => Promise<Outcome>> = {
  create, put, push, rm, update, delete: deleteSpace, inspect, get, pull,
};

/** `space <action>`: create and change Spaces with a Write Token, or read one from its Share Link. */
export async function space(ctx: Context, flags: SpaceFlags): Promise<Outcome> {
  const [action] = ctx.args;
  if (action && isAction(action)) return ACTIONS[action](ctx, flags);
  throw usage(action
    ? `Unknown action "space ${action}". Use one of: ${Object.keys(ACTIONS).join(', ')}.`
    : 'Use agentsync space <create|put|push|rm|update|delete|inspect|get|pull>. Run agentsync help space for usage.');
}
