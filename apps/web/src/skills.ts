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
export function describeState(skill: Pick<Skill, 'name' | 'pin'>, state: MachineSkillState) {
  switch (state.status) {
    case 'installed': return { dot: 'installed', label: 'Installed', detail: `At ${shortCommit(skill.pin.commit)}` };
    case 'pending': return {
      dot: 'pending',
      label: 'Pending',
      detail: { install: 'Installs on the next skills sync', update: 'Updates on the next skills sync', remove: 'Removed on the next skills sync' }[state.change],
    };
    case 'failed': return { dot: 'failed', label: 'Failed', detail: state.error };
    case 'blocked': return { dot: 'blocked', label: 'Blocked', detail: `Your own ${skill.name} folder is in the way` };
    case 'drifted': return { dot: 'drifted', label: 'Hand edited', detail: 'Replaced only with --overwrite' };
    case 'newer': return { dot: 'newer', label: 'Newer here', detail: `Has ${shortCommit(state.commit)} from ${shortDate(state.committedAt)}` };
    case 'not-set': return { dot: 'none', label: 'Not set', detail: '' };
  }
}

/**
 * Something a Skill needs from the person, most pressing kind first: an update, a newer version on
 * a Machine, a Found Skill to add, a failed install, a blocked one, a hand edit.
 */
export type Ask =
  | { kind: 'update'; risky: string[] }
  | { kind: 'newer'; machineId: string; commit: string }
  | { kind: 'found'; machineId: string }
  | { kind: 'failed'; machineId: string }
  | { kind: 'blocked'; machineId: string }
  | { kind: 'drifted'; machineId: string };

const ORDER: Ask['kind'][] = ['update', 'newer', 'found', 'failed', 'blocked', 'drifted'];

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
    case 'found': return `Found on ${name(ask.machineId)}`;
    case 'failed': return `Failed on ${name(ask.machineId)}`;
    case 'blocked': return `Blocked on ${name(ask.machineId)}`;
    case 'drifted': return `Hand edited on ${name(ask.machineId)}`;
  }
}

export type GitHubFound = Extract<FoundSkill, { kind: 'github' }>;

/** One line of the list: a Skill, or a Found Skill from GitHub that can be added. */
export type Entry =
  | { key: string; type: 'skill'; skill: Skill; asks: Ask[] }
  | { key: string; type: 'found'; found: GitHubFound; asks: Ask[] };

/** Every Skill and addable Found Skill, those that need the person first, by the kind of their first ask. */
export function entriesOf(overview: SkillsOverview): Entry[] {
  const rank = (asks: Ask[]) => (asks.length ? ORDER.indexOf(asks[0]!.kind) : ORDER.length);
  const entries: Entry[] = [
    ...overview.skills.map((skill): Entry => ({ key: `skill:${skill.id}`, type: 'skill', skill, asks: asksOf(skill) })),
    ...overview.found.flatMap((found): Entry[] => found.kind === 'github'
      ? [{ key: `found:${found.name}:${found.source}`, type: 'found', found, asks: [{ kind: 'found', machineId: found.machines[0]!.machineId }] }]
      : []),
  ];
  // A stable sort keeps the server's order (by name) within a kind.
  return entries.sort((a, b) => rank(a.asks) - rank(b.asks));
}

/** Whether a Machine gets the Skill under its assignment. */
export const isAssigned = (skill: Skill, machineId: string) =>
  skill.assignment.to === 'all' || skill.assignment.machineIds.includes(machineId);
