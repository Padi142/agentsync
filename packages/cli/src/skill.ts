import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

/** Remove the skill files AgentSync wrote that nobody changed since. */
export function uninstallSkills(ctx: Context): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const [file, installed] of Object.entries(ctx.config.skills ?? {})) {
    const text = readText(file);
    if (text === null) continue;
    if (hash(text) === installed) {
      removeFile(file);
      removed.push(file);
    } else {
      kept.push(file);
    }
  }
  return { removed, kept };
}
