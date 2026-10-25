import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Agent } from './agents.js';
import type { Context } from './context.js';
import { readText, removeFile, writeText } from './files.js';

/** The agent skill shipped in this package, at `skill/SKILL.md`. */
const skillText = () => readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8');

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Install the skill for `agent`, or update it. A file is only replaced while it is still
 * exactly what AgentSync wrote (by the hash in the config); a file someone wrote or changed is
 * left alone. Returns whether the skill was written.
 */
export function installSkill(ctx: Context, agent: Agent): { file: string; written: boolean } {
  const file = agent.skillFile(ctx.io);
  const current = readText(file);
  const wanted = skillText();
  const skills = (ctx.config.skills ??= {});
  const ours = current === null || current === wanted || skills[file] === hash(current);
  if (!ours) return { file, written: false };
  if (current !== wanted) writeText(file, wanted);
  skills[file] = hash(wanted);
  ctx.save();
  return { file, written: true };
}

/**
 * Remove the skill's own directory (`skills/agentsync/`) once it is empty. A symlink there
 * (e.g. to a dotfiles directory) belongs to the person, so it stays.
 */
function removeEmptyDir(dir: string): void {
  try {
    if (lstatSync(dir).isSymbolicLink()) return;
    rmdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw error;
  }
}

/** Remove the skill files AgentSync wrote that nobody changed since. */
export function uninstallSkills(ctx: Context): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const [file, installed] of Object.entries(ctx.config.skills ?? {})) {
    const text = readText(file);
    if (text === null) continue;
    if (hash(text) === installed) {
      removeFile(file);
      removeEmptyDir(dirname(file));
      removed.push(file);
    } else {
      kept.push(file);
    }
  }
  return { removed, kept };
}
