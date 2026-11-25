import { lstatSync, readFileSync, rmdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Agent } from './agents.js';
import type { Context } from './context.js';
import { removeOwned, writeOwned } from './owned.js';

/** The agent skills shipped in this package, each at `skills/<name>/SKILL.md`, in the order `init` lists them. */
export const BUNDLED_SKILLS = ['agentsync-instructions', 'agentsync-skills', 'agentsync-spaces'] as const;

/** The single skill AgentSync installed before `BUNDLED_SKILLS` replaced it. */
const LEGACY_SKILL = 'agentsync';

const bundledText = (name: (typeof BUNDLED_SKILLS)[number]) =>
  readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');

/**
 * Install every bundled skill for `agent`, or update it. A file is only replaced while it is still
 * exactly what AgentSync wrote (by the hash in the config); a file someone wrote or changed is
 * left alone. Returns each skill file and whether it was written.
 */
export function installSkills(ctx: Context, agent: Agent, homeDir?: string): { file: string; written: boolean }[] {
  const record = (ctx.config.skills ??= {});
  const results = BUNDLED_SKILLS.map((name) => {
    const file = join(agent.skillsDir(ctx.io, homeDir), name, 'SKILL.md');
    return { file, written: writeOwned(record, file, bundledText(name)) };
  });
  if (results.some((result) => result.written)) ctx.save();
  return results;
}

/**
 * Remove a skill's own directory (`skills/<name>/`) once it is empty. A symlink there
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

/** Remove the skill files AgentSync wrote that nobody changed since, the legacy `agentsync` skill included. */
export function uninstallSkills(ctx: Context): { removed: string[]; kept: string[] } {
  const result = removeOwned(ctx.config.skills ?? {});
  for (const file of result.removed) removeEmptyDir(dirname(file));
  return result;
}

/**
 * Remove the legacy `agentsync` skill wherever AgentSync wrote it, if nobody changed it since (by
 * the hash in the config). A changed one is `kept`, and stays in the config so `logout` still
 * knows it; a folder AgentSync never wrote isn't in the config, so it is never touched.
 */
export function removeLegacySkills(ctx: Context): { removed: string[]; kept: string[] } {
  const record = ctx.config.skills ?? {};
  const legacy = Object.fromEntries(Object.entries(record).filter(([file]) => basename(dirname(file)) === LEGACY_SKILL));
  const result = removeOwned(legacy);
  const forgotten = Object.keys(legacy).filter((file) => !result.kept.includes(file));
  for (const file of forgotten) delete record[file];
  for (const file of result.removed) removeEmptyDir(dirname(file));
  if (forgotten.length) ctx.save();
  return result;
}
