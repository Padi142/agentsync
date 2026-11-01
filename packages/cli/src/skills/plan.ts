import type { DesiredSkill } from '@agentsync/contract';
import type { ManagedSkill } from '../config.js';
import type { Folder } from './scan.js';

/**
 * What `skills sync` does with one name:
 * - `install`: nothing is there; `update`: AgentSync's own undrifted copy of an earlier Pin;
 *   `replace`: its drifted copy, with `--overwrite`.
 * - `adopt`: a copy from the `skills` lock that is exactly the Pin becomes AgentSync's, without reinstalling.
 * - `unchanged`: AgentSync's copy is the Pin.
 * - `remove`: AgentSync's undrifted (or `--overwrite`) copy of a Skill this Machine should no longer have.
 * - `forget`: AgentSync's copy is gone already; drop the record.
 * - `drifted`: AgentSync's copy was edited by hand, so it is left until `--overwrite`.
 * - `blocked`: a folder AgentSync doesn't manage holds the name; it is never touched.
 */
export type SkillStep =
  | { name: string; action: 'install' | 'update' | 'replace' | 'adopt' | 'unchanged' | 'drifted' | 'blocked'; desired: DesiredSkill }
  | { name: string; action: 'remove' | 'forget' | 'drifted' };

const absent: Folder = { exists: false, hash: null, fromLock: false };

/**
 * Decide what `skills sync` does, from the Skills this Machine should have, what is on disk, and
 * AgentSync's own record. Only recorded folders are ever replaced or removed, and only while they still
 * hash to the Pin AgentSync installed, unless `overwrite`.
 */
export function planSkills(
  desired: readonly DesiredSkill[],
  folders: ReadonlyMap<string, Folder>,
  managed: Readonly<Record<string, ManagedSkill>>,
  overwrite: boolean,
): SkillStep[] {
  const steps: SkillStep[] = [];
  const wanted = new Set(desired.map((skill) => skill.name));
  for (const skill of desired) {
    const folder = folders.get(skill.name) ?? absent;
    const record = managed[skill.name];
    const step = (action: Extract<SkillStep, { desired: DesiredSkill }>['action']) => steps.push({ name: skill.name, action, desired: skill });
    if (!folder.exists) step('install');
    else if (folder.hash === skill.installedHash && (record || folder.fromLock)) step(record ? 'unchanged' : 'adopt');
    else if (!record) step('blocked');
    else if (folder.hash !== null && folder.hash === record.installedHash) step('update');
    else step(overwrite ? 'replace' : 'drifted');
  }
  for (const [name, record] of Object.entries(managed)) {
    if (wanted.has(name)) continue;
    const folder = folders.get(name) ?? absent;
    if (!folder.exists) steps.push({ name, action: 'forget' });
    else if (overwrite || (folder.hash !== null && folder.hash === record.installedHash)) steps.push({ name, action: 'remove' });
    else steps.push({ name, action: 'drifted' });
  }
  return steps;
}

/** What `skills sync` would change, for the hook's one line. */
export function pendingCounts(steps: readonly SkillStep[]) {
  const count = (...actions: SkillStep['action'][]) => steps.filter((step) => actions.includes(step.action)).length;
  return { install: count('install'), update: count('update'), remove: count('remove') };
}
