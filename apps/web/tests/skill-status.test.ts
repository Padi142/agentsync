import type { ScannedSkill } from '@agentsync/contract';
import { describe, expect, it } from 'vitest';
import { machineSkillState } from '../src/skills/status';

const sha = (c: string) => c.repeat(40);
const pin = { commit: sha('1'), installedHash: sha('a') };
const older = sha('b');
const newer = { installedHash: sha('c'), commit: sha('3'), committedAt: new Date('2026-10-01') };
const at = new Date('2026-10-30');

const scanned = (hash: string | null, more: Partial<ScannedSkill> = {}): ScannedSkill => ({
  name: 'demo', source: 'owner/repo', ref: null, hash, managed: true, ...more,
});

/** The state for a Skill assigned (or not) to a Machine that reported `found`. */
const state = (assigned: boolean, found?: ScannedSkill, result?: { commit: string; status: 'failed' | 'installed'; error?: string }) =>
  machineSkillState({
    assigned,
    pin,
    sources: ['owner/repo', 'owner/old-name'],
    olderHashes: new Set([older]),
    newer: [newer],
    scanned: found,
    result: result && { name: 'demo', ...result },
    syncedAt: at,
  });

describe('machineSkillState', () => {
  it('is installed when the managed folder matches the Pin', () => {
    expect(state(true, scanned(pin.installedHash))).toEqual({ status: 'installed' });
  });

  it('is pending install when the Machine has nothing yet', () => {
    expect(state(true)).toEqual({ status: 'pending', change: 'install' });
  });

  it('is pending update when the folder still matches an earlier Pin', () => {
    expect(state(true, scanned(older))).toEqual({ status: 'pending', change: 'update' });
  });

  it('offers a newer version the Machine has', () => {
    expect(state(true, scanned(newer.installedHash))).toEqual({ status: 'newer', commit: newer.commit, committedAt: newer.committedAt });
  });

  it('is drifted when the managed folder matches no known version, or its copies disagree', () => {
    expect(state(true, scanned(sha('e')))).toEqual({ status: 'drifted' });
    expect(state(true, scanned(null))).toEqual({ status: 'drifted' });
  });

  it('is blocked by a folder of that name that AgentSync does not manage', () => {
    expect(state(true, scanned(null, { managed: false, source: null }))).toEqual({ status: 'blocked' });
    expect(state(true, scanned(older, { managed: false }))).toEqual({ status: 'blocked' });
  });

  it('counts an unmanaged copy of the Pin from the Skill’s own repository as installed: skills sync adopts it', () => {
    expect(state(true, scanned(pin.installedHash, { managed: false }))).toEqual({ status: 'installed' });
    expect(state(true, scanned(pin.installedHash, { managed: false, source: 'Owner/Old-Name' }))).toEqual({ status: 'installed' });
    // The same bytes from another repository, or hand-written, are someone else's.
    expect(state(true, scanned(pin.installedHash, { managed: false, source: 'someone/else' }))).toEqual({ status: 'blocked' });
    expect(state(true, scanned(pin.installedHash, { managed: false, source: null }))).toEqual({ status: 'blocked' });
  });

  it('reports a failed install of the current Pin with its error', () => {
    expect(state(true, undefined, { commit: pin.commit, status: 'failed', error: 'clone failed' }))
      .toEqual({ status: 'failed', error: 'clone failed', at });
    // A failure at an earlier Pin is history: the new Pin is still to do.
    expect(state(true, undefined, { commit: sha('9'), status: 'failed', error: 'old' })).toEqual({ status: 'pending', change: 'install' });
  });

  it('is pending removal for an undrifted managed copy on a Machine the Skill is no longer assigned to', () => {
    expect(state(false, scanned(pin.installedHash))).toEqual({ status: 'pending', change: 'remove' });
    expect(state(false, scanned(older))).toEqual({ status: 'pending', change: 'remove' });
    expect(state(false, scanned(sha('e')))).toEqual({ status: 'drifted' });
  });

  it('is not set when it is neither assigned nor managed here', () => {
    expect(state(false)).toEqual({ status: 'not-set' });
    expect(state(false, scanned(null, { managed: false, source: null }))).toEqual({ status: 'not-set' });
  });
});
