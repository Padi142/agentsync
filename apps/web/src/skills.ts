import type { Audits, AuditRisk, FoundSkill, MachineSkillState, Skill, SkillsOverview } from '@agentsync/contract';

/** A commit as the dashboard shows it. */
export const shortCommit = (commit: string) => commit.slice(0, 7);

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
/** "Sep 15": when a version was committed. */
export const shortDate = (date: Date) => dateFormat.format(date);

export const RISK_NAMES: Record<AuditRisk, string> = { safe: 'Safe', low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
export const SCANNERS = [['gen', 'Gen'], ['socket', 'Socket'], ['snyk', 'Snyk']] as const;

/** The scanners rating a version High or Critical, e.g. `["Snyk High"]`. */
export const riskyVerdicts = (audits: Audits) =>
  SCANNERS.flatMap(([key, label]) => {
    const risk = audits[key]?.risk;
    return risk === 'high' || risk === 'critical' ? [`${label} ${RISK_NAMES[risk]}`] : [];
  });

type Machines = SkillsOverview['machines'];
export type MachineState = Skill['machines'][number];

/** How a Machine × Skill state reads: a dot, a short label and a line of detail. */
export function describeState(skill: Pick<Skill, 'name' | 'pin' | 'assignment'>, state: MachineSkillState & { machineId: string }) {
  switch (state.status) {
    case 'installed': return { dot: 'installed', label: 'Installed', detail: `At ${shortCommit(skill.pin.commit)}` };
    case 'pending': return {
      dot: 'pending',
      label: 'Pending',
      detail: { install: 'Installs on the next skills sync', update: 'Updates on the next skills sync', remove: 'Removed on the next skills sync' }[state.change],
    };
    case 'failed': return { dot: 'failed', label: 'Failed', detail: state.error };
    case 'blocked': return { dot: 'blocked', label: 'Blocked', detail: `Your own ${skill.name} folder is in the way` };
    // On a Machine the Skill no longer goes to, --overwrite deletes the edited copy instead of replacing it.
    case 'drifted': return {
      dot: 'drifted',
      label: 'Hand edited',
      detail: isAssigned(skill, state.machineId) ? 'Replaced only with --overwrite' : 'Removed only with --overwrite',
    };
    case 'newer': return { dot: 'newer', label: 'Newer here', detail: `Has ${shortCommit(state.commit)} from ${shortDate(state.committedAt)}` };
    case 'not-set': return { dot: 'none', label: 'Not set', detail: '' };
  }
}

/**
 * Something a Skill needs from the person, most pressing kind first: an update, a newer version on
 * a Machine, a failed install, a blocked one, a hand edit.
 */
export type Ask =
  | { kind: 'update'; risky: string[] }
  | { kind: 'newer'; machineId: string; commit: string }
  | { kind: 'failed'; machineId: string }
  | { kind: 'blocked'; machineId: string }
  | { kind: 'drifted'; machineId: string };

const ORDER: Ask['kind'][] = ['update', 'newer', 'failed', 'blocked', 'drifted'];

/** What one Skill needs from the person, most pressing first. */
export function asksOf(skill: Skill): Ask[] {
  const asks: Ask[] = [];
  if (skill.update) asks.push({ kind: 'update', risky: riskyVerdicts(skill.update.audits) });
  for (const state of skill.machines) {
    if (state.status === 'newer') asks.push({ kind: 'newer', machineId: state.machineId, commit: state.commit });
    if (state.status === 'failed' || state.status === 'blocked' || state.status === 'drifted') {
      asks.push({ kind: state.status, machineId: state.machineId });
    }
  }
  return asks.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** The reason a row shows on the right, e.g. "Update to 1a2c79d, Snyk High". */
export function askText(ask: Ask, skill: Skill | null, machines: Machines): string {
  const name = (id: string) => machines.find((machine) => machine.id === id)?.nickname ?? 'a Machine';
  switch (ask.kind) {
    case 'update': return `Update to ${shortCommit(skill!.update!.pin.commit)}${ask.risky.length ? `, ${ask.risky.join(', ')}` : ''}`;
    case 'newer': return `Newer on ${name(ask.machineId)}`;
    case 'failed': return `Failed on ${name(ask.machineId)}`;
    case 'blocked': return `Blocked on ${name(ask.machineId)}`;
    case 'drifted': return `Hand edited on ${name(ask.machineId)}`;
  }
}

export type GitHubFound = Extract<FoundSkill, { kind: 'github' }>;

/** One line of the list: a Skill, or a Found Skill from GitHub that can be synced. A Found Skill asks nothing of the person. */
export type Entry =
  | { key: string; type: 'skill'; skill: Skill; asks: Ask[] }
  | { key: string; type: 'found'; found: GitHubFound; asks: [] };

export type CollectionEntry = Entry | { key: string; type: 'ignored'; name: string; repo: string; asks: [] };
export interface SkillCollection {
  key: string;
  repo: string;
  entries: CollectionEntry[];
}

export const entryName = (entry: CollectionEntry) => entry.type === 'skill' ? entry.skill.name : entry.type === 'found' ? entry.found.name : entry.name;
export const entryRepo = (entry: CollectionEntry) => entry.type === 'skill' ? entry.skill.repo.fullName : entry.type === 'found' ? entry.found.source : entry.repo;

/** One collection per repository; exclusions stay visible even after the source Machine disappears. */
export function collectionsOf(overview: SkillsOverview): SkillCollection[] {
  const ignored = new Set(overview.ignored.map(({ repo, name }) => `${repo.toLowerCase()}:${name}`));
  const entries: CollectionEntry[] = [
    ...entriesOf(overview).filter((entry) => !ignored.has(`${entryRepo(entry).toLowerCase()}:${entryName(entry)}`)),
    ...overview.ignored.map(({ repo, name }): CollectionEntry => ({ key: `ignored:${repo}:${name}`, type: 'ignored', repo, name, asks: [] })),
  ];
  const groups = new Map<string, SkillCollection>();
  for (const entry of entries) {
    const repo = entryRepo(entry);
    const key = repo.toLowerCase();
    const group = groups.get(key) ?? { key, repo, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map((group) => ({
    ...group, entries: group.entries.sort((a, b) => entryName(a).localeCompare(entryName(b))),
  }));
}

/** Every Skill and syncable Found Skill, those that need the person first, by the kind of their first ask. */
export function entriesOf(overview: SkillsOverview): Entry[] {
  const rank = (asks: Ask[]) => (asks.length ? ORDER.indexOf(asks[0]!.kind) : ORDER.length);
  const entries: Entry[] = [
    ...overview.skills.map((skill): Entry => ({ key: `skill:${skill.id}`, type: 'skill', skill, asks: asksOf(skill) })),
    ...overview.found.flatMap((found): Entry[] => found.kind === 'github'
      ? [{ key: `found:${found.name}:${found.source}`, type: 'found', found, asks: [] }]
      : []),
  ];
  // A stable sort keeps the server's order (by name) within a kind.
  return entries.sort((a, b) => rank(a.asks) - rank(b.asks));
}

/** Whether a Machine gets the Skill under its assignment. */
export const isAssigned = (skill: Pick<Skill, 'assignment'>, machineId: string) =>
  skill.assignment.to === 'all' || skill.assignment.machineIds.includes(machineId);

/** The Machines named, or just how many once names would crowd a row. */
export function machineNames(ids: readonly string[], machines: Machines) {
  if (ids.length > 3) return `${ids.length} machines`;
  return ids.map((id) => machines.find((machine) => machine.id === id)?.nickname ?? 'a Machine').join(', ');
}

/** What each Machine with something pending will change on its next `skills sync`. */
export function waitingOn({ skills, machines }: Pick<SkillsOverview, 'skills' | 'machines'>) {
  return machines.flatMap((machine) => {
    const counts = { install: 0, update: 0, remove: 0 };
    for (const skill of skills) {
      const state = skill.machines.find((candidate) => candidate.machineId === machine.id);
      if (state?.status === 'pending') counts[state.change]++;
    }
    const changes = (['install', 'update', 'remove'] as const).flatMap((change) => counts[change] ? [`${counts[change]} to ${change}`] : []);
    return changes.length ? [{ machine, changes: changes.join(', ') }] : [];
  });
}
