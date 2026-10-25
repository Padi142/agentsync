import { copyFileSync, existsSync } from 'node:fs';
import { createTwoFilesPatch } from 'diff';
import { readText, writeText } from './files.js';

/**
 * - `missing`: nothing on disk, so write it.
 * - `current`: the file already holds the Rendered output.
 * - `stale`: the file is what AgentSync last wrote, and the Template or Variables moved on.
 * - `drift`: the file was edited by hand (or was never written by AgentSync) and differs.
 */
export type TargetStatus = 'missing' | 'current' | 'stale' | 'drift';

export interface TargetCheck {
  status: TargetStatus;
  /** For Drift: the hand edit as a unified diff, from what AgentSync wrote (or would write) to the file. */
  diff?: string;
}

/** Compare a Target on disk with its Rendered output and with what AgentSync last wrote there. */
export function checkTarget(target: { path: string; rendered: string; lastWritten?: string }): TargetCheck {
  const onDisk = readText(target.path);
  if (onDisk === null) return { status: 'missing' };
  if (onDisk === target.rendered) return { status: 'current' };
  if (onDisk === target.lastWritten) return { status: 'stale' };
  const before = target.lastWritten ?? target.rendered;
  const label = target.lastWritten === undefined ? 'Rendered by AgentSync' : 'last written by AgentSync';
  const diff = createTwoFilesPatch(`${target.path} (${label})`, `${target.path} (on disk)`, before, onDisk, '', '', {
    context: 3,
  });
  return { status: 'drift', diff };
}

export const backupPath = (path: string) => `${path}.agentsync-backup`;

/** Write the Rendered output to a Target. With `backup`, first copy the file it replaces to `<target>.agentsync-backup`. */
export function writeTarget(path: string, rendered: string, options: { backup: boolean }): void {
  if (options.backup && existsSync(path)) copyFileSync(path, backupPath(path));
  writeText(path, rendered);
}
