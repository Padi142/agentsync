import type { Skill, SkillsOverview } from '@agentsync/contract';
import { describe, expect, it } from 'vitest';
import { askText, collectionsOf, entriesOf, waitingOn } from '../src/skills';

const sha = (c: string) => c.repeat(40);
const pin = (c: string) => ({ commit: sha(c), treeSha: sha('t'), installedHash: sha('h'), committedAt: new Date('2026-10-01') });
const audit = (risk: 'safe' | 'high') => ({ risk, analyzedAt: new Date('2026-10-02') });
const machines = [{ id: 'a', nickname: 'laptop', checkedInAt: null }, { id: 'b', nickname: 'desktop', checkedInAt: null }];
const skill = (name: string, states: Skill['machines'], update: Skill['update'] = null): Skill => ({
  id: name, name, repo: { id: 1, fullName: 'o/r' }, path: name, pin: pin('1'), assignment: { to: 'all' },
  autoUpdate: true, update, machines: states, createdAt: new Date(0),
});
const overview = (skills: Skill[], found: SkillsOverview['found'] = []): SkillsOverview =>
  ({ settings: { autoUpdate: false }, skills, found, machines, ignored: [] });

describe('the Skills list', () => {
  it('groups mixed sources case-insensitively and keeps exclusions after scans disappear', () => {
    const data = overview([skill('managed', [])], [
      { kind: 'github', name: 'found', source: 'O/R', machines: [{ machineId: 'a', ref: null }] },
      { kind: 'github', name: 'excluded', source: 'o/r', machines: [{ machineId: 'a', ref: null }] },
    ]);
    data.ignored = [{ repo: 'o/r', name: 'excluded' }, { repo: 'gone/repo', name: 'remembered' }];
    const groups = collectionsOf(data);
    expect(groups.map((group) => group.key)).toEqual(['gone/repo', 'o/r']);
    expect(groups[1]!.entries.map((entry) => entry.type)).toEqual(['ignored', 'found', 'skill']);
    expect(groups[0]!.entries[0]).toMatchObject({ type: 'ignored', name: 'remembered' });
  });
  it('puts what needs the person first, by kind: update, newer, failed, blocked, hand edited', () => {
    const entries = entriesOf(overview([
      skill('calm', [{ machineId: 'a', status: 'installed' }]),
      skill('edited', [{ machineId: 'a', status: 'drifted' }]),
      skill('broken', [{ machineId: 'b', status: 'failed', error: 'x', at: new Date() }]),
      skill('stale', [{ machineId: 'a', status: 'installed' }], { pin: pin('2'), audits: { gen: audit('safe'), socket: null, snyk: null }, audited: false }),
      skill('ahead', [{ machineId: 'a', status: 'newer', commit: sha('3'), committedAt: new Date() }]),
    ], [{ kind: 'github', name: 'found', source: 'o/r', machines: [{ machineId: 'b', ref: null }] }, { kind: 'local', name: 'mine', machineIds: ['a'] }]));
    expect(entries.map((entry) => (entry.type === 'skill' ? entry.skill.name : entry.found.name)))
      .toEqual(['stale', 'ahead', 'broken', 'edited', 'calm', 'found']);
  });

  it('counts what each Machine will change on its next skills sync, leaving out Machines with nothing waiting', () => {
    const waiting = waitingOn(overview([
      skill('new', [{ machineId: 'a', status: 'pending', change: 'install' }, { machineId: 'b', status: 'installed' }]),
      skill('newer', [{ machineId: 'a', status: 'pending', change: 'update' }, { machineId: 'b', status: 'failed', error: 'x', at: new Date() }]),
      skill('other', [{ machineId: 'a', status: 'pending', change: 'install' }]),
    ]));
    expect(waiting).toEqual([{ machine: machines[0], changes: '2 to install, 1 to update' }]);
  });

  it('names High and Critical verdicts in an update’s reason', () => {
    const risky = skill('risky', [], { pin: pin('2'), audits: { gen: audit('safe'), socket: null, snyk: audit('high') }, audited: true });
    const [entry] = entriesOf(overview([risky]));
    expect(askText(entry!.asks[0]!, risky, machines)).toBe(`Update to ${sha('2').slice(0, 7)}, Snyk High`);
  });
});
