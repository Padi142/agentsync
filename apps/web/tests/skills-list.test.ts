import type { Skill, SkillsOverview } from '@agentsync/contract';
import { describe, expect, it } from 'vitest';
import { askText, entriesOf } from '../src/skills';

const sha = (c: string) => c.repeat(40);
const pin = (c: string) => ({ commit: sha(c), treeSha: sha('t'), installedHash: sha('h'), committedAt: new Date('2026-10-01') });
const audit = (risk: 'safe' | 'high') => ({ risk, analyzedAt: new Date('2026-10-02') });
const machines = [{ id: 'a', nickname: 'laptop', checkedInAt: null }, { id: 'b', nickname: 'desktop', checkedInAt: null }];
const skill = (name: string, states: Skill['machines'], update: Skill['update'] = null): Skill => ({
  id: name, name, repo: { id: 1, fullName: 'o/r' }, path: name, pin: pin('1'), assignment: { to: 'all' },
  autoUpdate: true, update, machines: states, createdAt: new Date(0),
});
const overview = (skills: Skill[], found: SkillsOverview['found'] = []): SkillsOverview =>
  ({ settings: { autoUpdate: false }, skills, found, machines });

describe('the Skills list', () => {
  it('puts what needs the person first, by kind: update, newer, found, failed, blocked, hand edited', () => {
    const entries = entriesOf(overview([
      skill('calm', [{ machineId: 'a', status: 'installed' }]),
      skill('edited', [{ machineId: 'a', status: 'drifted' }]),
      skill('broken', [{ machineId: 'b', status: 'failed', error: 'x', at: new Date() }]),
      skill('stale', [{ machineId: 'a', status: 'installed' }], { pin: pin('2'), audits: { gen: audit('safe'), socket: null, snyk: null }, audited: false }),
      skill('ahead', [{ machineId: 'a', status: 'newer', commit: sha('3'), committedAt: new Date() }]),
    ], [{ kind: 'github', name: 'found', source: 'o/r', machines: [{ machineId: 'b', ref: null }] }, { kind: 'local', name: 'mine', machineIds: ['a'] }]));
    expect(entries.map((entry) => (entry.type === 'skill' ? entry.skill.name : entry.found.name)))
      .toEqual(['stale', 'ahead', 'found', 'broken', 'edited', 'calm']);
  });

  it('names High and Critical verdicts in an update’s reason', () => {
    const risky = skill('risky', [], { pin: pin('2'), audits: { gen: audit('safe'), socket: null, snyk: audit('high') }, audited: true });
    const [entry] = entriesOf(overview([risky]));
    expect(askText(entry!.asks[0]!, risky, machines)).toBe(`Update to ${sha('2').slice(0, 7)}, Snyk High`);
  });
});
