import type { MachineSkillState, ScannedSkill, SkillSyncResult } from '@agentsync/contract';

/** What the server knows about one Skill on one Machine. */
export interface MachineSkillFacts {
  /** The Skill's assignment includes this Machine. */
  assigned: boolean;
  pin: { commit: string; installedHash: string };
  /** The `owner/repo` names (lowercase) a lock may record for the Skill's repository. */
  sources: readonly string[];
  /** The installed hashes of the Skill's earlier Pins. */
  olderHashes: ReadonlySet<string>;
  /** Versions of the folder on the default branch newer than the Pin, as far as the update check has seen. */
  newer: readonly { installedHash: string; commit: string; committedAt: Date }[];
  /** The folder of this name in the Machine's last scan, if any. */
  scanned: ScannedSkill | undefined;
  /** What the Machine's last `skills sync` did with this name, and when. */
  result: Pick<SkillSyncResult, 'name' | 'commit' | 'status' | 'error'> | undefined;
  syncedAt: Date | null;
}

/**
 * Where a Skill stands on a Machine, from the Machine's last report (see `machineSkillStateSchema`).
 * Only AgentSync's own copies (`managed`) can be installed, updated, drifted or removed; any other
 * folder of the name blocks it, except an unmanaged copy from the `skills` lock, from the Skill's own
 * repository, that is exactly the Pin: `skills sync` adopts that without reinstalling.
 */
export function machineSkillState(facts: MachineSkillFacts): MachineSkillState {
  const { assigned, pin, scanned, result } = facts;
  const failed = result?.status === 'failed' && result.commit === pin.commit && facts.syncedAt
    ? { status: 'failed' as const, error: result.error ?? 'The install failed.', at: facts.syncedAt }
    : null;

  if (!scanned || (!scanned.managed && !assigned)) {
    if (!assigned) return { status: 'not-set' };
    return failed ?? { status: 'pending', change: 'install' };
  }
  const { hash } = scanned;
  if (!scanned.managed) {
    const sameSource = scanned.source !== null && facts.sources.includes(scanned.source.toLowerCase());
    return sameSource && hash === pin.installedHash ? { status: 'installed' } : { status: 'blocked' };
  }
  const known = hash === pin.installedHash || (hash !== null && facts.olderHashes.has(hash));
  if (!assigned) return known ? { status: 'pending', change: 'remove' } : { status: 'drifted' };
  if (hash === pin.installedHash) return { status: 'installed' };
  if (known) return failed ?? { status: 'pending', change: 'update' };
  const version = facts.newer.find((candidate) => candidate.installedHash === hash);
  if (version) return { status: 'newer', commit: version.commit, committedAt: version.committedAt };
  return { status: 'drifted' };
}
