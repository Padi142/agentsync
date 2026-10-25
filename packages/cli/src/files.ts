import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The file's text, or `null` if it does not exist. */
export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Write through a temporary file and a rename, so a reader never sees half a file. */
export function writeText(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.agentsync-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temporary, text, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(temporary, mode);
  renameSync(temporary, path);
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

export function writeJson(path: string, value: unknown, mode?: number): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}
