import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { readText } from './files.js';
import type { Io } from './io.js';
import { configDir } from './paths.js';

/**
 * - `created`: the Target did not exist.
 * - `updated`: it held what AgentSync last wrote, and the Template or Variables moved on.
 * - `replaced`: a hand edit was overwritten; it is in `<target>.agentsync-backup`.
 */
export type ChangeAction = 'created' | 'updated' | 'replaced';

/** The revisions a Target was Rendered from. */
export interface Revisions {
  template: number;
  variables: number;
}

export interface TargetChange {
  /** As stored, e.g. `~/.claude/CLAUDE.md`. */
  path: string;
  agent: string;
  action: ChangeAction;
  /** What the Target was last written from, or `null` if AgentSync has no record of it. */
  previous: Revisions | null;
  /** The hunks of a unified diff from what was on disk to what AgentSync wrote; `null` if it was too large to keep. */
  diff: string | null;
}

/** One sync that wrote at least one Target on this Machine. */
export interface HistoryEntry {
  /** ISO 8601. */
  at: string;
  /** What ran the sync: an agent's SessionStart hook, `agentsync sync`, or `agentsync init`. */
  trigger: 'hook' | 'sync' | 'init';
  /** For `hook`: the agent whose session started. */
  hookAgent?: string;
  templateRevision: number;
  variablesRevision: number;
  changes: TargetChange[];
}

/** A diff that takes longer than this, or comes out larger, is not kept: a hook has seconds to finish. */
const DIFF_TIMEOUT_MS = 300;
const MAX_DIFF_BYTES = 64 * 1024;

/**
 * The log of Target writes: one JSON line per sync that changed something, oldest first. It is
 * only ever appended to, so agents starting at once never lose each other's lines. Entries are
 * written only when a Target changes and their diffs are capped, so it grows slowly.
 */
export const historyFile = (io: Io) => join(configDir(io), 'history.jsonl');

/** Only the hunks: the entry already says which file it is. */
export function changeDiff(path: string, before: string | null, after: string): string | null {
  const patch = createTwoFilesPatch(path, path, before ?? '', after, '', '', { context: 3, timeout: DIFF_TIMEOUT_MS });
  if (patch === undefined) return null;
  const hunks = patch.indexOf('@@');
  const diff = hunks < 0 ? '' : patch.slice(hunks);
  return Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES ? null : diff;
}

export function appendHistory(io: Io, entry: HistoryEntry): void {
  const file = historyFile(io);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // The leading newline ends a line a crash may have cut short, so this entry stays readable.
  appendFileSync(file, `\n${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** Every entry, oldest first. A line that does not parse (say, cut off by a crash) is skipped. */
export function readHistory(io: Io): HistoryEntry[] {
  const text = readText(historyFile(io)) ?? '';
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as HistoryEntry];
    } catch {
      return [];
    }
  });
}
