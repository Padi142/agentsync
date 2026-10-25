import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** The file's text, or `null` if it does not exist. */
export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** The file a write to `path` should replace: a symlink (e.g. from a dotfiles manager) is followed, so the link stays. */
function writablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  try {
    // A dangling symlink: write the file it points to.
    if (lstatSync(path).isSymbolicLink()) return writablePath(resolve(dirname(path), readlinkSync(path)));
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  return path;
}

function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export interface WriteOptions {
  /** The mode to set, even on an existing file (e.g. 0600 for the file that holds the Machine token). */
  mode?: number;
  /** The mode for a file that does not exist yet, narrowed by the umask. An existing file keeps its own mode. */
  createMode?: number;
  /** The mode for directories that have to be created. */
  dirMode?: number;
}

/**
 * Write through a temporary file and a rename, so a reader never sees half a file. The file
 * keeps its mode (unless `mode` is given), a new file gets `createMode` (default 0666) as
 * narrowed by the umask, and a symlink is followed rather than replaced. The temporary file
 * is created exclusively.
 */
export function writeText(path: string, text: string, options: WriteOptions = {}): void {
  const target = writablePath(path);
  mkdirSync(dirname(target), { recursive: true, ...(options.dirMode ? { mode: options.dirMode } : {}) });
  // An exact mode (forced, or the replaced file's) is set after the umask narrowed it; a new file's is left to the umask.
  const exact = options.mode ?? existingMode(target);
  const temporary = `${target}.agentsync-${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: exact ?? options.createMode ?? 0o666 });
    if (exact !== undefined) chmodSync(temporary, exact);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function removeFile(path: string): void {
  rmSync(path, { force: true });
}

/** Parse a JSON file, `fallback` if missing. A file that is not JSON is an error, so we never overwrite it. */
export function readJson<T>(path: string, fallback: T): T {
  const text = readText(path);
  if (text === null || text.trim() === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} is not valid JSON, so AgentSync left it alone. Fix it and try again.`);
  }
}

export function writeJson(path: string, value: unknown, options?: WriteOptions): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`, options);
}
