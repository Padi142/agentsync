import { createHash } from 'node:crypto';
import { readText, removeFile, writeText } from './files.js';

/**
 * Whole files AgentSync writes, such as the agent skill and the pi extension. `record` maps each
 * file to a SHA-256 of what AgentSync last wrote there (kept in the config), so a file someone
 * wrote or changed is never replaced or removed.
 */
export type Owned = Record<string, string>;

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Write `text` to `file` if it is missing or still exactly what AgentSync last wrote. Returns
 * whether the file now holds `text`; the caller saves the config.
 */
export function writeOwned(record: Owned, file: string, text: string): boolean {
  const current = readText(file);
  const ours = current === null || current === text || record[file] === hash(current);
  if (!ours) return false;
  if (current !== text) writeText(file, text);
  record[file] = hash(text);
  return true;
}

/** Remove the files in `record` that nobody changed since AgentSync wrote them. */
export function removeOwned(record: Owned): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const [file, written] of Object.entries(record)) {
    const text = readText(file);
    if (text === null) continue;
    if (hash(text) === written) {
      removeFile(file);
      removed.push(file);
    } else {
      kept.push(file);
    }
  }
  return { removed, kept };
}
