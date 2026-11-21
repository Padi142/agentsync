import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeSpacePath, SPACE_LIMITS } from '@agentsync/contract';
import { CliError, EXIT } from '../exit.js';

/**
 * The local side of Spaces: walking a directory to upload, and writing what a Space holds into one.
 * Every path the server names goes through `normalizeSpacePath` and must land inside the directory.
 */

/** Names never uploaded from a directory, at any depth. */
const JUNK = new Set(['.git', 'node_modules', '.DS_Store']);

/** A file found on disk: its Space path, where it is, and its size. */
export interface LocalFile {
  path: string;
  abs: string;
  size: number;
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const MB = 1024 * 1024;
export const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < MB ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / MB).toFixed(1)} MB`;

/**
 * Every regular file under `root`, as Space paths, sorted. Symlinks and `JUNK` are skipped, and so is a
 * name no Space path can hold (a control character, say): those come back in `skipped`.
 */
export async function walkDirectory(root: string): Promise<{ files: LocalFile[]; skipped: string[] }> {
  const files: LocalFile[] = [];
  const skipped: string[] = [];
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (JUNK.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const name = relative(root, abs).split(sep).join('/');
      if (entry.isDirectory()) await visit(abs);
      else if (entry.isSymbolicLink() || !entry.isFile()) skipped.push(name);
      else {
        const path = normalizeSpacePath(name);
        if (path === name) files.push({ path, abs, size: (await lstat(abs)).size });
        else skipped.push(name);
      }
    }
  };
  await visit(root);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), skipped };
}

/** Fail before uploading anything the server would refuse for its file count or size. */
export function checkLimits(files: readonly { path: string; size: number }[]): void {
  if (files.length > SPACE_LIMITS.maxFiles) {
    throw new CliError(`These are ${files.length} files; a Space holds at most ${SPACE_LIMITS.maxFiles} files.`, EXIT.error, { code: 'SPACE_FULL' });
  }
  const big = files.find((file) => file.size > SPACE_LIMITS.fileBytes);
  if (big) {
    throw new CliError(`${big.path} is ${formatBytes(big.size)}; a Space file can be at most ${formatBytes(SPACE_LIMITS.fileBytes)}.`, EXIT.error, { code: 'FILE_TOO_LARGE' });
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > SPACE_LIMITS.spaceBytes) {
    throw new CliError(`These files add up to ${formatBytes(total)}; a Space holds at most ${formatBytes(SPACE_LIMITS.spaceBytes)}.`, EXIT.error, { code: 'SPACE_FULL' });
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

/** The `Content-Type` to upload `path` with, from its extension. */
export const contentTypeFor = (path: string) => CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

/** Whether bytes of `contentType` can be printed as text: the server's text types (`isTextType`), plus SVG. */
export const isText = (contentType: string) =>
  /^(text\/|application\/(json|xml|javascript|yaml|toml|x-sh)\b|image\/svg\+xml)|^[^;]*\+json\b/i.test(contentType.trim());

/**
 * Where the Space path `remote` goes under `root`, or a thrown error if it can't go anywhere inside it,
 * whatever the server sent.
 */
export function localPath(root: string, remote: string): string {
  const unsafe = () => new CliError(`The server sent a path that isn't safe to write: ${JSON.stringify(remote)}. Nothing was written for it.`, EXIT.error);
  if (normalizeSpacePath(remote) !== remote) throw unsafe();
  const target = resolve(root, ...remote.split('/'));
  const inside = relative(resolve(root), target);
  // `..notes.md` is a fine file name; only a `..` segment leaves `root`.
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw unsafe();
  return target;
}

/**
 * `remote`'s parent directory under `root`, checked one segment at a time so a symlink inside `root`
 * can't carry a read, write or delete outside it. `create` makes missing ones; without it, a missing
 * one is `null`.
 */
async function parentDirectory(root: string, remote: string, create: boolean): Promise<string | null> {
  let dir = resolve(root);
  for (const segment of remote.split('/').slice(0, -1)) {
    dir = join(dir, segment);
    const stat = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat === null && !create) return null;
    // Parallel downloads make the same folder at once: someone else's mkdir is fine, if it made a real directory.
    const made = stat ?? await mkdir(dir).then(() => null, async (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return lstat(dir);
      throw error;
    });
    if (made && !made.isDirectory()) throw new CliError(`${dir} is in the way of ${remote}: it isn't a directory.`, EXIT.error);
  }
  return dir;
}

/** The regular file at `remote` under `root`, if there is one there to read or remove. */
async function existing(root: string, remote: string) {
  const target = localPath(root, remote);
  if ((await parentDirectory(root, remote, false)) === null) return null;
  const stat = await lstat(target).catch(() => null);
  return stat && !stat.isDirectory() ? { target, isFile: stat.isFile() } : null;
}

/** The SHA-256 of the regular file at `remote` under `root`, or `null` (missing, a symlink, a directory). */
export async function localHash(root: string, remote: string): Promise<string | null> {
  const file = await existing(root, remote);
  return file?.isFile ? sha256(await readFile(file.target)) : null;
}

/**
 * Write `bytes` to `remote` under `root` through a temporary file and a rename, so a reader never sees
 * half a file and a symlink at the target is replaced, not followed.
 */
export async function writeLocal(root: string, remote: string, bytes: Uint8Array): Promise<void> {
  const target = localPath(root, remote);
  await mkdir(root, { recursive: true });
  const dir = (await parentDirectory(root, remote, true))!;
  const temporary = join(dir, `.agentsync-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Remove `remote` under `root` if it is there (a symlink is removed, never followed), then prune
 * empty parent directories up to (never including) `root` so a later file at a former folder's
 * path won't fail with `EISDIR`.
 */
export async function removeLocal(root: string, remote: string): Promise<void> {
  const file = await existing(root, remote);
  if (!file) return;
  await rm(file.target);
  const resolvedRoot = resolve(root);
  let dir = dirname(file.target);
  while (dir !== resolvedRoot) {
    const rel = relative(resolvedRoot, dir);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) break;
    const stat = await lstat(dir).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) break;
    try {
      await rmdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') break;
      throw error;
    }
    dir = dirname(dir);
  }
}
