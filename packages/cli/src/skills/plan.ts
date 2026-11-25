import type { DesiredSkill, Target } from '@agentsync/contract';
import { agentInstances } from '../agents.js';
import type { Io } from '../io.js';
import type { Folder } from './scan.js';
import { canonicalPlace, canonicalSkillsDir, claudePlace, ownedDirs, recordOf, skillDir, type ManagedSkill, type Place } from './state.js';

/**
 * What `skills sync` does with one name:
 * - `install`: nothing is there. `update`: AgentSync's own undrifted copy of an earlier Pin, or one
 *   missing a directory an agent needs. `replace`: its drifted copy, with `--overwrite`.
 * - `adopt`: a copy from the Skill's own repository (by the `skills` lock) that is exactly the Pin, in
 *   every needed directory, becomes AgentSync's without reinstalling.
 * - `unchanged`: AgentSync's copy is the Pin, everywhere it is needed.
 * - `remove`: AgentSync's undrifted (or `--overwrite`) copy of a Skill this Machine should no longer have.
 * - `forget`: AgentSync's copy is gone already; drop the record.
 * - `drifted`: AgentSync's copy was edited by hand, so it waits for `--overwrite`. (A copy its own
 *   failed install left mixed is not drifted: `update` finishes it.)
 * - `blocked`: a folder AgentSync doesn't own holds the name, in some directory, or the `skills` lock
 *   says it came from another source (or not from GitHub). Never touched, even with `--overwrite`.
 */
export type SkillStep =
  | {
    name: string;
    action: 'install' | 'update' | 'replace' | 'adopt' | 'unchanged' | 'drifted' | 'blocked';
    desired: DesiredSkill;
    /** The directories the name is in now: what an adopted Skill owns. */
    present: Place[];
  }
  | { name: string; action: 'remove' | 'forget' | 'drifted' | 'blocked'; record: ManagedSkill };

const absent: Folder = { present: [], skill: false, hash: null, lockSource: null, lockOther: false };

/**
 * The skills directories a Skill must be in for this Machine's Targets:
 * each Claude Code instance reads its own `skills/`, Antigravity reads `~/.gemini/config/skills`,
 * and Codex, pi and OpenCode share `~/.agents/skills`.
 */
export function requiredPlaces(targets: readonly Target[], io: Io): Place[] {
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const { agent, homeDir } of agentInstances(targets, io)) {
    const place: Place =
      agent.id === 'claude' ? claudePlace(homeDir, io) : canonicalPlace(agent.id === 'antigravity' ? 'antigravity' : 'agents', io);
    const key = canonicalSkillsDir(skillDir(io, place));
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(place);
  }
  return places;
}

/** Whether `record` owns `place`, matching the canonical skills directory recorded when ownership was established. */
export const ownedPlace = (record: ManagedSkill, place: Place, io?: Io): boolean => {
  if (place === 'claude' && record.legacyClaude) return false;
  if (!io) return record.places.includes(place);
  return ownedDirs(record, io).has(canonicalSkillsDir(skillDir(io, place)));
};

/** Someone else's: a folder in a directory AgentSync never wrote to, an unverified legacy `'claude'` copy, or a lock entry from another source. */
export const foreign = (folder: Folder, record: ManagedSkill, io?: Io) =>
  folder.present.some((place) => !ownedPlace(record, place, io)) ||
  folder.lockOther ||
  (folder.lockSource !== null && !record.sources.includes(folder.lockSource));

/**
 * True when an interrupted update (`record.incomplete`) left copies split across the old and new Pins
 * (or an already-verified orphan partially removed), and every other copy still matches a verified Pin.
 */
export function isIncompleteUntouched(folder: Folder, record: ManagedSkill, io?: Io): boolean {
  if (!record.incomplete || !folder.present.length) return false;
  const expected = new Set([record.installedHash, ...(record.previousHashes ?? [])]);
  const orphans = new Set(record.orphanDirs ?? []);
  return folder.present.every((place) => {
    const hash = folder.placeHashes?.get(place);
    if (hash === undefined && io && orphans.has(canonicalSkillsDir(skillDir(io, place)))) return true;
    return hash !== null && hash !== undefined && expected.has(hash);
  });
}

/**
 * Decide what `skills sync` does, from the Skills this Machine should have, what is on disk, AgentSync's
 * record, and the directories its agents need. Only folders AgentSync recorded as its own are ever
 * replaced or removed, and only while they still hash to the Pin it installed, unless `overwrite`.
 */
export function planSkills(
  desired: readonly DesiredSkill[],
  folders: ReadonlyMap<string, Folder>,
  managed: Readonly<Record<string, ManagedSkill>>,
  required: readonly Place[],
  overwrite: boolean,
  /** Names the server still lists but this CLI can't act on: never removed. */
  keep: ReadonlySet<string> = new Set(),
  io?: Io,
): SkillStep[] {
  const steps: SkillStep[] = [];
  const wanted = new Set([...desired.map((skill) => skill.name), ...keep]);

  for (const skill of desired) {
    const folder = folders.get(skill.name) ?? absent;
    const record = recordOf(managed, skill.name);
    const step = (action: Extract<SkillStep, { desired: DesiredSkill }>['action']) =>
      steps.push({ name: skill.name, action, desired: skill, present: folder.present });
    const complete = required.every((place) => folder.present.includes(place));
    if (!folder.present.length) step('install');
    else if (!record) {
      const adoptable = folder.lockSource !== null && skill.sources.includes(folder.lockSource) && folder.hash === skill.installedHash;
      step(adoptable && complete ? 'adopt' : 'blocked');
    } else if (foreign(folder, record, io)) step('blocked');
    else if (folder.hash === skill.installedHash) step(complete && !record.incomplete ? 'unchanged' : 'update');
    else if ((folder.hash !== null && folder.hash === record.installedHash) || isIncompleteUntouched(folder, record, io)) step('update');
    else step(overwrite ? 'replace' : 'drifted');
  }
  for (const [name, record] of Object.entries(managed)) {
    if (wanted.has(name)) continue;
    const folder = folders.get(name) ?? absent;
    if (!folder.present.length) steps.push({ name, action: 'forget', record });
    else if (foreign(folder, record, io)) steps.push({ name, action: 'blocked', record });
    else if (overwrite || (folder.hash !== null && folder.hash === record.installedHash) || isIncompleteUntouched(folder, record, io)) {
      steps.push({ name, action: 'remove', record });
    } else steps.push({ name, action: 'drifted', record });
  }
  return steps;
}

/** What `skills sync` would change, for the hook's and `sync`'s one line. */
export function pendingCounts(steps: readonly SkillStep[]) {
  const count = (...actions: SkillStep['action'][]) => steps.filter((step) => actions.includes(step.action)).length;
  return { install: count('install'), update: count('update'), remove: count('remove') };
}
