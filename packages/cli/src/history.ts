import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { readText, writeText } from './files.js';
import type { Io } from './io.js';
import { configDir } from './paths.js';

/**
 * - `created`: the Target did not exist.
 * - `updated`: it held what AgentSync last wrote, and the Template or Variables moved on.
 * - `replaced`: a hand edit was overwritten; it is in `<target>.agentsync-backup`.
 */
export type ChangeAction = 'created' | 'updated' | 'replaced';

export interface TargetChange {
  /** As stored, e.g. `~/.claude/CLAUDE.md`. */
  path: string;
  agent: string;
  action: ChangeAction;
  /** The hunks of a unified diff from what was on disk to what AgentSync wrote. */
  diff: string;
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

/** Past this size the log keeps only its newer half, so it never grows without bound. */
const MAX_BYTES = 1024 * 1024;

/**
 * The log of Target writes: one JSON line per sync that changed something, oldest first. It is
 * appended to rather than rewritten, so agents starting at once do not lose each other's lines.
 */
export const historyFile = (io: Io) => join(configDir(io), 'history.jsonl');

/** Only the hunks: the entry already says which file it is. */
export function changeDiff(path: string, before: string | null, after: string): string {
  const patch = createTwoFilesPatch(path, path, before ?? '', after, '', '', { context: 3 });
  const hunks = patch.indexOf('@@');
  return hunks < 0 ? '' : patch.slice(hunks);
}

export function appendHistory(io: Io, entry: HistoryEntry): void {
  const file = historyFile(io);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  if (statSync(file).size > MAX_BYTES) {
    const lines = readText(file)!.split('\n').filter(Boolean);
    writeText(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
  }
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
