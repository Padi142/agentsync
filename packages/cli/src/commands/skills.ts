import { createHash } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  desiredSkillSchema, gitShaSchema, repoNameSchema, RESERVED_SKILL_NAMES, SKILL_REQUEST_LIMITS, skillNameSchema,
  type ContractClient, type DesiredSkill, type SkillRequest, type SkillSyncResult, type SyncPayload, type Target,
} from '@agentsync/contract';
import { safe } from '@orpc/client';
import { agentInstances, findAgent } from '../agents.js';
import type { Context, Outcome } from '../context.js';
import { CliError, describeError, EXIT, usage } from '../exit.js';
import { machineClient } from '../session.js';
import { expandHome, tildify } from '../paths.js';
import { foreign, isIncompleteUntouched, ownedPlace, pendingCounts, planSkills, requiredPlaces, type SkillStep } from '../skills/plan.js';
import { addSkills, removeSkills } from '../skills/runner.js';
import { forgetLockEntry, scanSkills, skillDir, type Folder, type Scan } from '../skills/scan.js';
import {
  canonicalSkillsDir,
  claudeHomeForPlace,
  claudePlace,
  isClaudePlace,
  isSymlinkedSkillsDir,
  persistedDirPlaces,
  readSkillsState,
  recordOf,
  SKILLS_STATE_VERSION,
  updateSkillsState,
  withSkillsLock,
  type ManagedSkill,
  type Place,
  type SkillsState,
} from '../skills/state.js';

/** The hook reports an unchanged scan again after this long, so the dashboard knows the Machine checked in. */
const REPORT_EVERY_MS = 24 * 60 * 60 * 1000;

const short = (commit: string) => commit.slice(0, 7);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

interface InstallBatch {
  agents: string[];
  env?: Record<string, string>;
}

/**
 * Plan the `skills add` calls needed so every directory required by this Machine's Targets, plus every
 * directory AgentSync already owns for these Skills (a stale copy there would read as Drift), gets
 * updated. Extra Claude Code instances each need their own call with `CLAUDE_CONFIG_DIR` set.
 */
function installPlan(
  payload: SyncPayload,
  owned: readonly Place[],
  io: Context['io'],
): { batches: InstallBatch[]; places: Place[]; writtenPlaces: Place[] } {
  const required = requiredPlaces(payload.machine.targets, io);
  const seenDirs = new Set<string>();
  const places: Place[] = [];
  for (const place of [...required, ...owned]) {
    const key = canonicalSkillsDir(skillDir(io, place));
    if (seenDirs.has(key)) continue;
    seenDirs.add(key);
    places.push(place);
  }
  const claudeHomes = places.filter(isClaudePlace).map((place) => claudeHomeForPlace(place, io));
  const wantAgentsDir = places.includes('agents');
  const wantAntigravity = places.includes('antigravity');

  // Preserve the Machine's target order for the primary `skills add` invocation.
  const primaryAgents: string[] = [];
  const addPrimary = (agent: string) => {
    if (!primaryAgents.includes(agent)) primaryAgents.push(agent);
  };
  let hasUniversal = false;
  for (const target of payload.machine.targets) {
    const agent = findAgent(target.agent);
    if (!agent) continue;
    if (agent.id === 'claude') {
      if (claudeHomes.length) addPrimary('claude-code');
    } else if (agent.id === 'antigravity') {
      if (wantAntigravity) addPrimary('antigravity');
    } else if (wantAgentsDir) {
      addPrimary(agent.skillsAgent);
      hasUniversal = true;
    }
  }
  if (claudeHomes.length) addPrimary('claude-code');
  if (wantAgentsDir && !hasUniversal) addPrimary('codex');
  if (wantAntigravity) addPrimary('antigravity');

  const batches: InstallBatch[] = [];
  if (primaryAgents.length) {
    batches.push({
      agents: primaryAgents,
      ...(claudeHomes[0] ? { env: { CLAUDE_CONFIG_DIR: claudeHomes[0] } } : {}),
    });
  }
  for (const homeDir of claudeHomes.slice(1)) {
    batches.push({ agents: ['claude-code'], env: { CLAUDE_CONFIG_DIR: homeDir } });
  }
  // When `skills add` runs in symlink mode (`claude-code` paired with another agent in one call),
  // it also writes the canonical copy in `~/.agents/skills`, so a halfway failure there stays ours.
  const usesCanonical = batches.some((batch) => batch.agents.includes('claude-code') && batch.agents.some((agent) => agent !== 'claude-code'));
  const writtenPlaces = usesCanonical && !places.includes('agents') ? [...places, 'agents' as const] : places;
  return { batches, places, writtenPlaces };
}

/**
 * Older AgentSync versions (without `version: 2` in `skills.json`) recorded a custom `$CLAUDE_CONFIG_DIR`
 * as `'claude'`. For legacy records only, re-key `'claude'` to the uniquely matching registered custom
 * `claude:<dir>` Target (preferring `$CLAUDE_CONFIG_DIR` if it matches) when `~/.claude/skills/<name>`
 * is absent and the copy's hash and lock source match the Pin. Unmatched legacy records keep
 * `legacyClaude: true` so migration still works after the custom home is registered.
 */
function migrateLegacyClaude(
  state: SkillsState,
  folders: ReadonlyMap<string, Folder>,
  targets: readonly Target[],
  io: Context['io'],
): boolean {
  const fileLegacy = state.version !== SKILLS_STATE_VERSION;
  const defaultClaudeHome = canonicalSkillsDir(join(io.home, '.claude'));
  const defaultClaudePlace = claudePlace(defaultClaudeHome, io);
  const claudeHomes = agentInstances(targets, io)
    .filter(({ agent }) => agent.id === 'claude')
    .map(({ homeDir }) => homeDir);
  const defaultRequired = claudeHomes.some((homeDir) => canonicalSkillsDir(homeDir) === defaultClaudeHome);
  const customRequired: Place[] = [
    ...new Set(
      claudeHomes
        .filter((homeDir) => canonicalSkillsDir(homeDir) !== defaultClaudeHome)
        .map((homeDir) => claudePlace(homeDir, io))
        .filter((place) => place !== 'claude' && place !== defaultClaudePlace),
    ),
  ];
  const envDir = io.env.CLAUDE_CONFIG_DIR?.trim();
  const envPlace = envDir ? claudePlace(expandHome(envDir, io), io) : undefined;
  let changed = false;
  for (const [name, record] of Object.entries(state.managed)) {
    const isLegacy = fileLegacy || Boolean(record.legacyClaude);
    if (!isLegacy || !record.places.includes('claude')) continue;
    const folder = folders.get(name);
    const lockMatches = folder !== undefined && folder.lockSource !== null && record.sources.includes(folder.lockSource);
    const matchesPlace = (place: Place) =>
      lockMatches &&
      folder.present.includes(place) &&
      folder.placeHashes?.get(place) === record.installedHash;
    const matching = customRequired.filter((place) => matchesPlace(place));
    const otherPresent = (folder?.present ?? []).filter((place) => place !== 'claude' && !record.places.includes(place));
    const otherMatching = otherPresent.filter((place) => matchesPlace(place));
    const defaultAllowed = record.legacyClaude !== 'ambiguous' || envPlace === 'claude';
    const defaultMatches =
      defaultRequired &&
      defaultAllowed &&
      !isSymlinkedSkillsDir(skillDir(io, 'claude'), io) &&
      (!envPlace || envPlace === 'claude') &&
      matchesPlace('claude');
    const target =
      envPlace && matching.includes(envPlace)
        ? envPlace
        : matching.length === 1 && !defaultMatches && otherMatching.every((place) => place === matching[0])
          ? matching[0]
          : undefined;
    // Only verify ~/.claude when registered, not symlinked elsewhere, not previously ambiguous
    // (unless $CLAUDE_CONFIG_DIR points there), $CLAUDE_CONFIG_DIR isn't pointing elsewhere, the copy
    // matches the Pin and lock source, and no other present place (registered or detected) coexists.
    if (defaultMatches && !matching.length && !otherPresent.length) {
      if (record.legacyClaude) {
        delete record.legacyClaude;
        changed = true;
      }
      const nextDirs: Record<string, string> = {};
      for (const place of record.places) {
        if (!isSymlinkedSkillsDir(skillDir(io, place), io)) nextDirs[place] = canonicalSkillsDir(skillDir(io, place));
      }
      if (Object.keys(nextDirs).length) record.placeDirs = nextDirs;
      continue;
    }
    if (target) {
      record.places = [...new Set(record.places.map((place) => (place === 'claude' ? target : place)))];
      delete record.legacyClaude;
      const nextDirs: Record<string, string> = {};
      for (const place of record.places) {
        if (place === target || !isSymlinkedSkillsDir(skillDir(io, place), io)) {
          nextDirs[place] = canonicalSkillsDir(skillDir(io, place));
        }
      }
      if (Object.keys(nextDirs).length) record.placeDirs = nextDirs;
      changed = true;
    } else if (otherPresent.length && folder?.present.includes('claude')) {
      if (record.legacyClaude !== 'ambiguous') {
        record.legacyClaude = 'ambiguous';
        changed = true;
      }
    } else if (fileLegacy && !record.legacyClaude) {
      record.legacyClaude = true;
      changed = true;
    }
  }
  return changed;
}

const scanHash = (scan: Scan) => createHash('sha256').update(JSON.stringify(scan.items)).digest('hex');

/** Send a scan (and `skills sync` results), and remember it so the hook doesn't send it again. */
async function report(ctx: Context, client: ContractClient, scan: Scan, results?: SkillSyncResult[], until?: number, partial = false) {
  // A result for a name the server couldn't have sent validly is the person's to see, not the server's.
  const valid = results?.filter((result) => skillNameSchema.safeParse(result.name).success);
  await client.skills.report({ scan: scan.items, ...(valid ? { results: valid, ...(partial ? { partial } : {}) } : {}) });
  // A hook past its deadline has already printed and is on its way out: it leaves the files alone.
  if (until !== undefined && Date.now() > until) return;
  updateSkillsState(ctx.io, (state) => { state.report = { hash: scanHash(scan), at: Date.now() }; });
}

/** The Skills from the server that may be acted on: anything else (a name `skills` would rename, say) fails. */
function checkedDesired(payload: SyncPayload) {
  const valid: DesiredSkill[] = [];
  const invalid: SkillSyncResult[] = [];
  /** Names the server lists that can't be acted on: whatever is installed under them stays. */
  const keep = new Set<string>();
  for (const skill of payload.skills) {
    // The CLI's own skills are never Skills, whatever the server says.
    if (!RESERVED_SKILL_NAMES.includes(skill.name) && desiredSkillSchema.safeParse(skill).success) {
      valid.push(skill);
      continue;
    }
    if (typeof skill.name === 'string') keep.add(skill.name);
    if (gitShaSchema.safeParse(skill.commit).success && /^[a-z0-9-]{1,64}$/.test(skill.name)) {
      invalid.push({ name: skill.name, commit: skill.commit, status: 'failed', error: 'The server sent a Skill this CLI can’t install safely.' });
    }
  }
  return { valid, invalid, keep };
}

/**
 * Install, update, adopt and remove Skills so this Machine matches its Pins, through the `skills` CLI,
 * holding the Skills lock. Only folders AgentSync recorded as its own are replaced or removed, drifted
 * ones only with `overwrite`; anything else of a Skill's name blocks it. Each install is planned again
 * from a fresh look at the disk just before it runs. Saves the record, then reports to the server.
 * With `only`, it acts on those names alone and leaves every other Skill as it is.
 */
export async function syncSkills(ctx: Context, client: ContractClient, payload: SyncPayload, overwrite: boolean, only?: ReadonlySet<string>) {
  const { io } = ctx;
  const inScope = (name: string) => !only || only.has(name);
  return withSkillsLock(io, async () => {
    const state = readSkillsState(io);
    const { managed } = state;
    const checked = checkedDesired(payload);
    const { keep } = checked;
    const desired = checked.valid.filter((skill) => inScope(skill.name));
    const invalid = checked.invalid.filter((result) => inScope(result.name));
    const results: SkillSyncResult[] = [...invalid];
    const result = (name: string, commit: string, status: SkillSyncResult['status'], error?: string) =>
      results.push({ name, commit, status, ...(error ? { error: error.slice(0, 2000) } : {}) });
    const required = requiredPlaces(payload.machine.targets, io);
    /** Plan `names` again from the disk as it is now. */
    const replan = async (names: string[]) => {
      const now = await scanSkills(io, managed, names, { only: true, places: required });
      return planSkills(desired.filter((skill) => names.includes(skill.name)), now.folders, managed, required, overwrite, keep, io)
        .filter((step) => names.includes(step.name));
    };
    const settle = (step: SkillStep) => {
      const commit = 'desired' in step ? step.desired.commit : step.record.commit;
      if (step.action === 'adopt' && 'desired' in step) {
        managed[step.name] = recordFor(step.desired, step.present, io);
        result(step.name, commit, 'adopted');
      } else if (step.action === 'unchanged' && 'desired' in step) {
        const before = recordOf(managed, step.name)!;
        const normalizedPresent = step.present.map((place) => normalizeDirPlace(place, io));
        const presentDirs = dirsForPlaces(normalizedPresent, io);
        const presentDirSet = new Set(Object.values(presentDirs));
        const keptPlaces: Place[] = [];
        const nextDirs: Record<string, string> = { ...presentDirs };
        for (const place of before.places) {
          if (place === 'claude' && before.legacyClaude) {
            keptPlaces.push(place);
            continue;
          }
          const recordedDir = before.placeDirs?.[place];
          if (!recordedDir && isSymlinkedSkillsDir(skillDir(io, place), io)) continue;
          const dir = recordedDir ?? canonicalSkillsDir(skillDir(io, place));
          if (presentDirSet.has(dir)) continue;
          const key: Place =
            place.startsWith('dir:') || (Object.hasOwn(nextDirs, place) && nextDirs[place] !== dir)
              ? `dir:${tildify(dir, io)}`
              : place;
          keptPlaces.push(key);
          nextDirs[key] = dir;
        }
        managed[step.name] = {
          ...recordFor(step.desired, [...new Set([...keptPlaces, ...normalizedPresent])], io, nextDirs),
          ...(before.legacyClaude ? { legacyClaude: before.legacyClaude } : {}),
        };
        result(step.name, commit, 'unchanged');
      } else if (step.action === 'forget') {
        delete managed[step.name];
      } else if (step.action === 'blocked' || step.action === 'drifted') {
        result(step.name, commit, step.action);
      }
    };

    let migrated = false;
    try {
      const initialScan = await scanSkills(io, managed, desired.map((skill) => skill.name), { places: required });
      migrateLegacyClaude(state, initialScan.folders, payload.machine.targets, io);
      migrated = true;
      const steps = planSkills(desired, initialScan.folders, managed, required, overwrite, keep, io)
        .filter((step) => inScope(step.name));
      for (const step of steps) settle(step);

      const removals = steps.filter((step) => step.action === 'remove').map((step) => step.name);
      if (removals.length) {
        const still = await replan(removals);
        for (const step of still) if (step.action !== 'remove') settle(step);
        const names = still.filter((step) => step.action === 'remove').map((step) => step.name);
        if (names.length) {
          const extraClaudeHomes = [...new Set(
            names
              .flatMap((name) => {
                const record = recordOf(managed, name);
                if (!record) return [];
                return [
                  ...record.places.filter((place) => ownedPlace(record, place, io)),
                  ...required.filter((place) => ownedPlace(record, place, io)),
                ];
              })
              .filter((place) => place.startsWith('claude:'))
              .map((place) => claudeHomeForPlace(place, io)),
          )];
          await ctx.during(`Removing ${names.join(', ')}…`, () => removeSkills(ctx, names, extraClaudeHomes)).catch(() => undefined);
          // Hashed per skill against AgentSync's records, so one unreadable skill never prevents another from
          // recording retry state, and a copy edited or made unreadable since the plan is never deleted below.
          for (const name of names) {
            const record = recordOf(managed, name)!;
            let leftover: Folder | undefined;
            try {
              leftover = (await scanSkills(io, managed, [name], { only: true, places: required })).folders.get(name);
            } catch (error) {
              result(name, record.commit, 'failed', describeError(error));
              continue;
            }
            let left = leftover?.present ?? [];
            // `skills` keeps the shared `~/.agents/skills` copy while another agent it knows (Cursor or OpenCode, say)
            // reads that directory, or may delete `SKILL.md` before hitting a permission error on a nested file.
            // If every surviving copy is still AgentSync's unedited copy (or already stripped of SKILL.md by remove),
            // finish the removal here and record any surviving directories for retry before touching the lock file.
            const expectedHashes = new Set([record.installedHash, ...(record.previousHashes ?? [])]);
            const removablePlace = (place: Place) => {
              if (overwrite) return true;
              const hash = leftover?.placeHashes?.get(place);
              if (hash === undefined) return true;
              return hash !== null && expectedHashes.has(hash);
            };
            const ours = leftover !== undefined && !foreign(leftover, record, io) && left.every(removablePlace);
            if (left.length && ours) {
              for (const place of left) {
                await rm(join(skillDir(io, place), name), { recursive: true, force: true }).catch(() => undefined);
              }
              const beforeDirs = new Set(left.map((place) => canonicalSkillsDir(skillDir(io, place))));
              const seenCheck = new Set<string>();
              const surviving: Place[] = [];
              for (const place of [
                ...left,
                ...[...record.places, ...persistedDirPlaces(record, io)].filter((p) => ownedPlace(record, p, io)),
              ]) {
                const dir = canonicalSkillsDir(skillDir(io, place));
                if (seenCheck.has(dir)) continue;
                seenCheck.add(dir);
                const stillThere = await lstat(join(skillDir(io, place), name)).then(
                  () => true,
                  (error: NodeJS.ErrnoException) => error.code !== 'ENOENT' && error.code !== 'ENOTDIR',
                );
                if (stillThere) surviving.push(place);
              }
              left = surviving;
              if (left.length) {
                record.incomplete = true;
                const retryDirs = left
                  .map((place) => canonicalSkillsDir(skillDir(io, place)))
                  .filter((dir) => beforeDirs.has(dir));
                if (retryDirs.length) record.orphanDirs = [...new Set([...(record.orphanDirs ?? []), ...retryDirs])];
              } else {
                await forgetLockEntry(io, name).catch(() => undefined);
              }
            }
            if (left.length) result(name, record.commit, 'failed', 'skills remove left it on disk.');
            else {
              delete managed[name];
              result(name, record.commit, 'removed');
            }
          }
        }
      }

      const installs = steps.filter((step): step is Extract<SkillStep, { desired: DesiredSkill }> =>
        step.action === 'install' || step.action === 'update' || step.action === 'replace');
      // One `skills add` per repository and commit: one clone for all its Skills.
      const groups = new Map<string, typeof installs>();
      for (const step of installs) {
        const key = `${step.desired.repo}#${step.desired.commit}`;
        groups.set(key, [...(groups.get(key) ?? []), step]);
      }
      for (const group of groups.values()) {
        const { repo, commit } = group[0]!.desired;
        if (!required.length) {
          for (const step of group) result(step.name, commit, 'failed', 'No agent on this Machine takes Skills: AgentSync installs them for Claude Code, Codex, pi, OpenCode and Antigravity.');
          continue;
        }
        // The disk may have changed while earlier groups installed: act only on what still holds.
        const fresh = await replan(group.map((step) => step.name));
        const go = fresh.filter((step): step is Extract<SkillStep, { desired: DesiredSkill }> =>
          step.action === 'install' || step.action === 'update' || step.action === 'replace');
        for (const step of fresh) if (!go.includes(step as never)) settle(step);
        if (!go.length) continue;
        const names = go.map((step) => step.name);
        const owned = [...new Set(go.flatMap((step) => {
          const record = recordOf(managed, step.name);
          if (!record) return [];
          return record.places.filter((place) => {
            if (place.startsWith('dir:')) return false;
            if (record.legacyClaude && place === 'claude') return false;
            const recordedDir = record.placeDirs?.[place];
            return recordedDir
              ? canonicalSkillsDir(skillDir(io, place)) === recordedDir
              : !isSymlinkedSkillsDir(skillDir(io, place), io);
          });
        }))];
        const { batches, places: wrote, writtenPlaces } = installPlan(payload, owned, io);
        const outcomes = new Map<string, { ok: true } | { ok: false; error: string }>();
        try {
          await ctx.during(`Installing ${names.join(', ')} from ${repo}…`, async () => {
            for (const batch of batches) {
              const part = await addSkills(ctx, repo, commit, names, batch.agents, batch.env);
              for (const [name, status] of part) {
                const prev = outcomes.get(name);
                if (!prev || (prev.ok && !status.ok)) outcomes.set(name, status);
              }
            }
          });
        } catch (error) {
          const message = describeError(error);
          for (const name of names) {
            if (!outcomes.get(name) || outcomes.get(name)!.ok) outcomes.set(name, { ok: false, error: message });
          }
        }
        const writtenDirs = new Set(writtenPlaces.map((place) => canonicalSkillsDir(skillDir(io, place))));
        const orphanPlaces = [...new Set(
          go.flatMap((step) => {
            const before = recordOf(managed, step.name);
            return before
              ? persistedDirPlaces(before, io).filter((place) => !writtenDirs.has(canonicalSkillsDir(skillDir(io, place))))
              : [];
          }),
        )];
        const after = await scanSkills(io, {}, names, { only: true, places: [...writtenPlaces, ...orphanPlaces] });
        const presentPlaceFor = (current: Folder | undefined, place: Place): Place | undefined => {
          const dir = canonicalSkillsDir(skillDir(io, place));
          return current?.present.find((found) => canonicalSkillsDir(skillDir(io, found)) === dir);
        };
        for (const step of go) {
          let folder = after.folders.get(step.name);
          const said = outcomes.get(step.name);
          const before = recordOf(managed, step.name);
          const orphanDirs = new Set(
            before
              ? [
                  ...persistedDirPlaces(before, io).map((place) => canonicalSkillsDir(skillDir(io, place))),
                  ...(before.orphanDirs ?? []),
                ].filter((dir) => !writtenDirs.has(dir))
              : [],
          );
          const presentOrphans = (current: Folder | undefined) =>
            (current?.present ?? []).filter((place) => orphanDirs.has(canonicalSkillsDir(skillDir(io, place))));
          const stepOrphans = presentOrphans(folder);
          const priorOrphans = new Set(before?.orphanDirs ?? []);
          // If the update succeeded in every active target, clean up untouched copies in persisted directories
          // whose aliases were deleted or repointed elsewhere so no stale copy is orphaned on disk.
          const activeUpdated =
            wrote.every((place) => presentPlaceFor(folder, place) !== undefined) &&
            (!said || said.ok) &&
            (overwrite ||
              wrote.every((place) => {
                const found = presentPlaceFor(folder, place);
                return found !== undefined && folder?.placeHashes?.get(found) === step.desired.installedHash;
              }));
          const attemptedOrphanDirs = new Set(priorOrphans);
          if (before && stepOrphans.length && activeUpdated) {
            const expectedOld = new Set([before.installedHash, ...(before.previousHashes ?? [])]);
            const removable = stepOrphans.filter((place) => {
              if (overwrite) return true;
              const dir = canonicalSkillsDir(skillDir(io, place));
              const hash = folder?.placeHashes?.get(place);
              if (hash === undefined && priorOrphans.has(dir)) return true;
              return hash !== null && hash !== undefined && expectedOld.has(hash);
            });
            if (removable.length) {
              for (const place of removable) {
                attemptedOrphanDirs.add(canonicalSkillsDir(skillDir(io, place)));
                await rm(join(skillDir(io, place), step.name), { recursive: true, force: true }).catch(() => undefined);
              }
              folder = (await scanSkills(io, {}, [step.name], { only: true, places: [...writtenPlaces, ...orphanPlaces] })).folders.get(step.name);
            }
          }
          const remainingOrphans = presentOrphans(folder);
          const remainingOrphanDirs = [...new Set(
            remainingOrphans
              .map((place) => canonicalSkillsDir(skillDir(io, place)))
              .filter((dir) => attemptedOrphanDirs.has(dir)),
          )];
          const orphanLeft = remainingOrphans.length > 0;
          const placed = [...new Set(
            writtenPlaces
              .map((place) => presentPlaceFor(folder, place))
              .filter((place): place is Place => place !== undefined)
              .map((place) => normalizeDirPlace(place, io)),
          )];
          const missingRequired = wrote.some((place) => presentPlaceFor(folder, place) === undefined);
          const present = (folder?.present ?? []).map((place) => normalizeDirPlace(place, io));
          if (!orphanLeft && folder?.hash === step.desired.installedHash) {
            managed[step.name] = recordFor(step.desired, present, io);
          } else if (before && !orphanLeft && present.every((place) => ownedPlace(before, place, io)) && folder?.hash === before.installedHash) {
            // Nothing was written: the copy is still the earlier Pin, and stays recorded as that.
          } else if (present.length) {
            // `skills` wrote part of it (or an orphan couldn't be removed): AgentSync's, and the next sync finishes it.
            const previousHashes = [...new Set([
              ...(before?.previousHashes ?? []),
              ...(before?.installedHash ? [before.installedHash] : []),
            ])].filter((hash) => hash !== step.desired.installedHash);
            const nextDirs: Record<string, string> = dirsForPlaces(placed, io);
            const nextPlaces: Place[] = [...placed];
            const addDir = (place: Place, dir: string) => {
              if (Object.values(nextDirs).includes(dir)) return;
              const key: Place =
                place.startsWith('dir:') || (Object.hasOwn(nextDirs, place) && nextDirs[place] !== dir)
                  ? `dir:${tildify(dir, io)}`
                  : place;
              nextPlaces.push(key);
              nextDirs[key] = dir;
            };
            const priorPlaces = before?.legacyClaude ? before.places.filter((place) => place !== 'claude') : (before?.places ?? []);
            for (const place of priorPlaces) {
              const recorded = before?.placeDirs?.[place];
              if (recorded) addDir(place, recorded);
              else if (!isSymlinkedSkillsDir(skillDir(io, place), io)) addDir(place, canonicalSkillsDir(skillDir(io, place)));
            }
            for (const place of present) addDir(place, canonicalSkillsDir(skillDir(io, place)));
            managed[step.name] = {
              ...recordFor(step.desired, [...new Set(nextPlaces)], io, nextDirs),
              incomplete: true,
              ...(previousHashes.length ? { previousHashes } : {}),
              ...(remainingOrphanDirs.length ? { orphanDirs: remainingOrphanDirs } : {}),
            };
          }
          if (said && !said.ok) result(step.name, commit, 'failed', said.error);
          else if (missingRequired) result(step.name, commit, 'failed', 'skills add didn’t write every agent’s copy.');
          else if (orphanLeft) result(step.name, commit, 'failed', 'Could not remove the old copy left behind at a removed alias.');
          else if (folder?.hash !== step.desired.installedHash) result(step.name, commit, 'failed', 'The installed folder does not match its Pin.');
          else result(step.name, commit, step.action === 'install' ? 'installed' : 'updated');
        }
      }
    } finally {
      updateSkillsState(io, (saved) => {
        if (migrated) saved.version = SKILLS_STATE_VERSION;
        saved.places = required;
        saved.managed = managed;
      });
    }

    let reportError: string | undefined;
    let scan: Scan = { items: [], folders: new Map(), places: [] };
    try {
      scan = await scanSkills(io, managed, [], { places: required });
      await report(ctx, client, scan, results, undefined, only !== undefined);
    } catch (error) {
      reportError = describeError(error);
    }
    return { results, reportError, scan };
  });
}

/** Normalize any `dir:` Place to its canonical path so `dir:` keys can never collide across different directories. */
function normalizeDirPlace(place: Place, io: Context['io']): Place {
  return place.startsWith('dir:') ? `dir:${tildify(canonicalSkillsDir(skillDir(io, place)), io)}` : place;
}

/** Map each verified Place to the canonical skills directory it points to now. */
function dirsForPlaces(places: readonly Place[], io: Context['io']): Record<string, string> {
  const dirs: Record<string, string> = {};
  for (const place of places) {
    const dir = canonicalSkillsDir(skillDir(io, place));
    dirs[place.startsWith('dir:') ? `dir:${tildify(dir, io)}` : place] = dir;
  }
  return dirs;
}

/** AgentSync's record of a Skill it wrote or adopted in `places`, persisting each Place's canonical directory. */
function recordFor(
  skill: DesiredSkill,
  places: readonly Place[],
  io: Context['io'],
  placeDirs?: Record<string, string>,
): ManagedSkill {
  const normalized = [
    ...new Set(places.map((place) => (placeDirs && Object.hasOwn(placeDirs, place) ? place : normalizeDirPlace(place, io)))),
  ];
  const dirs = placeDirs ?? dirsForPlaces(normalized, io);
  return {
    repo: skill.repo,
    commit: skill.commit,
    installedHash: skill.installedHash,
    sources: skill.sources,
    places: normalized,
    ...(Object.keys(dirs).length ? { placeDirs: dirs } : {}),
  };
}

/** Point at the Skills page when this Machine has skills AgentSync doesn't manage: they're added there. */
function sayFound(ctx: Context, scan: Scan) {
  const found = scan.items.filter((item) => !item.managed).length;
  if (found && ctx.config.server) {
    ctx.say(`Found ${plural(found, 'skill')} on this Machine that AgentSync doesn't manage. Sync the ones you want everywhere at ${new URL('/skills', ctx.config.server)}`);
  }
}

/** Say what happened to each Skill, and why anything was left alone. */
function narrate(ctx: Context, results: SkillSyncResult[]) {
  for (const { name, commit, status, error } of results) {
    if (status === 'installed') ctx.say(`Installed ${name} @ ${short(commit)}`);
    else if (status === 'updated') ctx.say(`Updated ${name} to ${short(commit)}`);
    else if (status === 'adopted') ctx.detail(`${name} was already installed at its Pin; AgentSync manages it now.`);
    else if (status === 'removed') ctx.say(`Removed ${name}`);
    else if (status === 'failed') ctx.warn(`Could not install ${name}: ${error}`);
    else if (status === 'blocked') ctx.warn(`${name} is blocked by a skill of that name AgentSync didn't install. It's left alone; move or rename it to get the Skill.`);
    else if (status === 'drifted') ctx.warn(`${name} was edited by hand, so it was left alone. Run \`agentsync skills sync --overwrite\` to replace or remove it.`);
  }
}

/** `skills sync`: the only command that installs or removes Skills. */
async function skillsSync(ctx: Context): Promise<Outcome> {
  const client = machineClient(ctx);
  const payload = await ctx.during('Fetching your Skills…', () => client.machines.sync());
  const { results, reportError, scan } = await syncSkills(ctx, client, payload, ctx.flags.overwrite);
  narrate(ctx, results);
  if (reportError) ctx.warn(`Could not tell the server what changed: ${reportError}`);
  const has = (...statuses: SkillSyncResult['status'][]) => results.some((result) => statuses.includes(result.status));
  if (!has('failed', 'blocked', 'drifted')) {
    const changed = results.filter((result) => ['installed', 'updated', 'removed'].includes(result.status)).length;
    const count = payload.skills.length;
    ctx.success(changed ? `Skills synced · ${plural(changed, 'change')}`
      : count ? `${count === 1 ? 'The Skill is' : `All ${count} Skills are`} up to date` : 'No Skills are set for this Machine');
  }
  sayFound(ctx, scan);
  return {
    code: has('failed') ? EXIT.error : has('blocked', 'drifted') ? EXIT.drift : EXIT.ok,
    data: { skills: results, ...(reportError ? { reportError } : {}) },
  };
}

const describeStep = {
  install: 'Not installed',
  update: 'Update to install',
  replace: 'Hand edited',
  adopt: 'Installed',
  unchanged: 'Installed',
  drifted: 'Hand edited',
  blocked: 'Blocked by a skill AgentSync didn’t install',
  remove: 'To remove',
  forget: 'Gone',
} as const;

/** The plan for this Machine, as `skills sync` would see it now (without `--overwrite`). */
async function currentPlan(ctx: Context, payload: SyncPayload) {
  const state = readSkillsState(ctx.io);
  const { valid: desired, keep } = checkedDesired(payload);
  const required = requiredPlaces(payload.machine.targets, ctx.io);
  const { folders } = await scanSkills(ctx.io, state.managed, desired.map((skill) => skill.name), { places: required });
  migrateLegacyClaude(state, folders, payload.machine.targets, ctx.io);
  return planSkills(desired, folders, state.managed, required, false, keep, ctx.io).filter((step) => step.action !== 'forget');
}

/** `skills status`: each Skill on this Machine against its Pin, without changing anything. */
async function skillsStatus(ctx: Context): Promise<Outcome> {
  const payload = await ctx.during('Fetching your Skills…', () => machineClient(ctx).machines.sync());
  const steps = await currentPlan(ctx, payload);
  const width = Math.max(0, ...steps.map((step) => step.name.length));
  if (!steps.length) ctx.say('No Skills are set for this Machine.');
  for (const step of steps) {
    const where = 'desired' in step ? `  ${step.desired.repo} @ ${short(step.desired.commit)}` : '';
    ctx.say(`  ${step.name.padEnd(width)}  ${describeStep[step.action]}${where}`);
  }
  const { install, update, remove } = pendingCounts(steps);
  if (install + update + remove) ctx.say('Run `agentsync skills sync` to bring this Machine up to date.');
  return {
    data: {
      skills: steps.map((step) => ({
        name: step.name,
        state: step.action,
        ...('desired' in step ? { repo: step.desired.repo, commit: step.desired.commit } : {}),
      })),
    },
  };
}

export async function skills(ctx: Context): Promise<Outcome> {
  const [action, ...rest] = ctx.args;
  if (action === 'add') return skillsAdd(ctx, rest);
  if (rest.length) throw usage(`Unexpected argument "${rest[0]}". Run agentsync help skills for usage.`);
  if (action === 'sync') return skillsSync(ctx);
  if (action === 'status') return skillsStatus(ctx);
  throw usage(action ? `Unknown action "skills ${action}". Use skills sync, skills status or skills add.` : 'Use agentsync skills sync, skills status or skills add.');
}

/** How long `skills add` waits for the browser, and how often it looks. */
const APPROVAL_WAIT_MS = 10 * 60 * 1000;
const APPROVAL_POLL_MS = 3000;
/** How many calls `skills add` makes while the server is still reading a large repository. */
const MAX_READS = 10;

/** `owner/repo` from what a person may paste: `owner/repo`, or the repository's GitHub URL. */
function repoArgument(input: string): string {
  const repo = input.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '');
  if (!repoNameSchema.safeParse(repo).success) {
    throw usage(`"${input}" isn't a GitHub repository. Use owner/repo or https://github.com/owner/repo.`);
  }
  return repo;
}

/** Make (or resume) the Skill Request, calling again while the server reads a large repository. */
async function requestSkills(ctx: Context, client: ContractClient, repo: string, names: string[]) {
  for (let call = 0; call < MAX_READS; call++) {
    const [error, made, defined] = await safe(client.skills.request({ repo, ...(names.length ? { names } : {}) }));
    if (!error) {
      if (made.status === 'ready') return made;
      continue;
    }
    if (!defined) throw error;
    switch (error.code) {
      case 'UNKNOWN_SKILLS': throw new CliError(
        `${repo} has no skill named ${error.data.unknown.join(', ')}. It has: ${error.data.available.join(', ') || 'none'}.`,
        EXIT.usage, { unknown: error.data.unknown, available: error.data.available },
      );
      case 'REQUEST_LIMIT': throw new CliError(
        `${SKILL_REQUEST_LIMITS.open} Skill Requests are already waiting. Approve or reject them at ${new URL('/skills', ctx.config.server)}, or let them expire.`,
        EXIT.error, { code: error.code },
      );
      case 'NOT_FOUND': throw new CliError(`GitHub has no public repository ${repo}.`, EXIT.error, { code: error.code });
      case 'UNSUPPORTED_SKILL': throw new CliError(error.data.reason, EXIT.error, { code: error.code });
      case 'UPSTREAM_UNAVAILABLE': throw new CliError('GitHub or skills.sh didn’t answer. Try again in a minute.', EXIT.error, { code: error.code });
      default: throw error;
    }
  }
  throw new CliError(`AgentSync is still reading ${repo}. Run the command again to carry on.`, EXIT.error);
}

/** Look at the request until the browser decides or the wait is over (`null`). A dropped connection is retried. */
async function waitForDecision(ctx: Context, client: ContractClient, requestId: string): Promise<SkillRequest | null> {
  for (let waited = 0; waited < APPROVAL_WAIT_MS; waited += APPROVAL_POLL_MS) {
    await ctx.io.sleep(APPROVAL_POLL_MS);
    const [error, request] = await safe(client.skills.getRequest({ requestId }));
    if (error) {
      if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) continue;
      throw error;
    }
    if (request.status !== 'open') return request;
  }
  return null;
}

/** Skills a request proposes that a folder AgentSync doesn't manage already holds here, unless `skills sync` would adopt it. */
async function inTheWay(ctx: Context, request: SkillRequest) {
  const { managed } = readSkillsState(ctx.io);
  const { folders } = await scanSkills(ctx.io, managed, request.skills.map((skill) => skill.name), { only: true });
  return request.skills.filter((skill) => {
    const folder = folders.get(skill.name);
    if (!folder?.present.length || recordOf(managed, skill.name)) return false;
    const adoptable = folder.lockSource === request.repo.fullName.toLowerCase() && folder.hash === skill.pin.installedHash;
    return !adoptable;
  }).map((skill) => skill.name);
}

/**
 * `skills add`: a Skill Request. Only a signed-in browser adds Skills (ADR 0005), so this asks, prints
 * the link and waits; then it installs on this Machine just the Skills approved, as `skills sync` does.
 */
async function skillsAdd(ctx: Context, args: string[]): Promise<Outcome> {
  const [input, ...names] = args;
  if (!input) throw usage('Name a repository: agentsync skills add <owner/repo> [names…].');
  const repo = repoArgument(input);
  const bad = names.find((name) => !skillNameSchema.safeParse(name).success);
  if (bad !== undefined) throw usage(`"${bad}" isn't a skill name.`);
  if (names.length > SKILL_REQUEST_LIMITS.skills) throw usage(`Name at most ${SKILL_REQUEST_LIMITS.skills} skills at a time.`);
  const client = machineClient(ctx);
  const { request, resumed } = await ctx.during(`Reading ${repo}…`, () => requestSkills(ctx, client, repo, names));
  const proposed = request.skills.map((skill) => skill.name);
  const shown = { id: request.id, url: request.url, repo: request.repo.fullName, skills: proposed, resumed };

  // The server hands back the same ask approved since the last run (`--no-wait`, or a wait that ran out): just install it.
  let decided: SkillRequest | null = request.status === 'open' ? null : request;
  if (!decided) {
    ctx.say(`${resumed ? 'Still waiting for approval of' : 'Asked to add'} ${plural(proposed.length, 'skill')} from ${request.repo.fullName}: ${proposed.join(', ')}.\n\nApprove: ${request.url}\n`);
    const blocked = await inTheWay(ctx, request).catch(() => []);
    if (blocked.length) {
      ctx.warn(`${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} already on this Machine, installed outside AgentSync. If approved, ${blocked.length === 1 ? 'it stays' : 'they stay'} blocked here until you move or rename ${blocked.length === 1 ? 'that folder' : 'those folders'}.`);
    }
    const waiting = (): Outcome => {
      ctx.say('Run the same command again to keep waiting.');
      return { code: EXIT.pending, data: { status: 'pending', request: shown } };
    };
    if (!ctx.flags.wait) return waiting();
    decided = await ctx.during('Waiting for approval in the browser…', () => waitForDecision(ctx, client, request.id));
    if (!decided) {
      ctx.warn('Not approved yet.');
      return waiting();
    }
  }
  if (decided.status === 'rejected') throw new CliError('The Skill Request was rejected.', EXIT.error, { status: 'rejected', request: shown });
  if (decided.status === 'expired') throw new CliError('The Skill Request expired. Run the command again to ask again.', EXIT.error, { status: 'expired', request: shown });

  const added = decided.added;
  const approved = { status: 'approved', request: shown, added };
  ctx.success(`Approved ${plural(added.length, 'Skill')}: ${added.join(', ')}`);
  if (!ctx.flags.sync) {
    ctx.say('Run `agentsync skills sync` to install them.');
    return { data: approved };
  }
  const payload = await ctx.during('Fetching your Skills…', () => client.machines.sync());
  const here = new Set(payload.skills.filter((skill) => added.includes(skill.name)).map((skill) => skill.name));
  if (!here.size) {
    ctx.say('None of them are set for this Machine.');
    return { data: { ...approved, skills: [] } };
  }
  const { results, reportError } = await syncSkills(ctx, client, payload, false, here);
  narrate(ctx, results);
  if (reportError) ctx.warn(`Could not tell the server what changed: ${reportError}`);
  const has = (...statuses: SkillSyncResult['status'][]) => results.some((result) => statuses.includes(result.status));
  return {
    code: has('failed') ? EXIT.error : has('blocked', 'drifted') ? EXIT.drift : EXIT.ok,
    data: { ...approved, skills: results, ...(reportError ? { reportError } : {}) },
  };
}

/** The words for what `skills sync` would do, or `null` if nothing. */
function pendingText(steps: SkillStep[]): string | null {
  const { install, update, remove } = pendingCounts(steps);
  const parts = [
    install && `${plural(install, 'Skill')} to install`,
    update && plural(update, 'update'),
    remove && `${remove} to remove`,
  ].filter(Boolean);
  return parts.length ? `${parts.join(', ')}; run \`agentsync skills sync\`` : null;
}

/** For plain `agentsync sync`: what `skills sync` would do, said once. It never fails the sync. */
export async function pendingSkills(ctx: Context, payload: SyncPayload) {
  try {
    const steps = await currentPlan(ctx, payload);
    const line = pendingText(steps);
    if (line) ctx.warn(`Skills: ${line}.`);
    return pendingCounts(steps);
  } catch {
    return undefined;
  }
}

/**
 * The hook's part: scan (in-process, tens of milliseconds), report the scan if it changed or a day
 * passed, and say what `skills sync` would do once `payload` arrives, all before `deadline`. It never
 * installs anything and never throws: a failure or the deadline only means no line and no report.
 */
export async function hookSkills(ctx: Context, payload: Promise<SyncPayload>, deadline: number): Promise<string | null> {
  try {
    const state = readSkillsState(ctx.io);
    const { managed, report: last } = state;
    const initial = await scanSkills(ctx.io, managed, [], { deadline, places: state.places ?? [] });
    const initialHash = scanHash(initial);
    const due = !last || last.hash !== initialHash || Date.now() - last.at >= REPORT_EVERY_MS;
    const remaining = deadline - Date.now();
    // Start reporting in parallel with `payload` so a slow or timed-out `machines.sync` cannot starve it.
    const sent = due && remaining > 0
      ? report(ctx, machineClient(ctx, remaining), initial, undefined, deadline).catch(() => undefined)
      : Promise.resolve();
    let rescan: Scan | undefined;
    let required: Place[] | undefined;
    let line: string | null = null;
    try {
      const resolved = await payload;
      const { valid: desired, keep } = checkedDesired(resolved);
      required = requiredPlaces(resolved.machine.targets, ctx.io);
      const hasUnscanned = required.some((place) => !initial.places.includes(place));
      if (hasUnscanned) {
        rescan = await scanSkills(ctx.io, managed, desired.map((skill) => skill.name), { deadline, places: required });
      }
      const active = rescan ?? initial;
      migrateLegacyClaude(state, active.folders, resolved.machine.targets, ctx.io);
      // Names the listing didn't see are simply absent: they count as to install.
      line = pendingText(planSkills(desired, active.folders, managed, required, false, keep, ctx.io));
    } catch {
      // The Template part reports why the server could not be reached.
    }
    await sent;
    if (required && Date.now() <= deadline) {
      const samePlaces = state.places?.length === required.length &&
        required.every((place, index) => state.places![index] === place);
      if (!samePlaces) updateSkillsState(ctx.io, (saved) => { saved.places = required; });
    }
    if (rescan) {
      const rescanHash = scanHash(rescan);
      const needsReport = due
        ? rescanHash !== initialHash
        : !last || last.hash !== rescanHash || Date.now() - last.at >= REPORT_EVERY_MS;
      const left = deadline - Date.now();
      if (needsReport && left > 0) {
        await report(ctx, machineClient(ctx, left), rescan, undefined, deadline).catch(() => undefined);
      }
    }
    return line;
  } catch {
    return null;
  }
}

/**
 * `init`'s part: adopt Skills already installed at their Pin, then offer to install the rest
 * ("N Skills … Install the other K now?"). `--skills` installs, `--no-skills` skips, and without
 * either a non-interactive run skips and prints the command.
 */
export async function initSkills(ctx: Context, client: ContractClient, payload: SyncPayload) {
  const { io } = ctx;
  const desired = checkedDesired(payload).valid;
  const required = requiredPlaces(payload.machine.targets, io);
  const steps = await withSkillsLock(io, async () => {
    const state = readSkillsState(io);
    const { managed } = state;
    const { folders } = await scanSkills(io, managed, desired.map((skill) => skill.name), { places: required });
    const migrated = migrateLegacyClaude(state, folders, payload.machine.targets, io);
    const planned = planSkills(desired, folders, managed, required, false, new Set(), io);
    const adopted = planned.filter((step) => step.action === 'adopt' && 'desired' in step);
    if (migrated || adopted.length) {
      updateSkillsState(io, (saved) => {
        saved.version = SKILLS_STATE_VERSION;
        saved.places = required;
        if (migrated) saved.managed = managed;
        for (const step of adopted) if ('desired' in step) saved.managed[step.name] = recordFor(step.desired, step.present, io);
      });
    }
    return planned;
  });
  const { install, update } = pendingCounts(steps);
  const missing = install + update;
  const present = steps.filter((step) => step.action === 'adopt' || step.action === 'unchanged').length;
  const inTheWay = steps.filter((step) => step.action === 'blocked' || step.action === 'drifted').length;
  const total = payload.skills.length;
  const skip = async () => {
    const scan = await scanSkills(io, readSkillsState(io).managed, [], { places: required });
    await report(ctx, client, scan).catch(() => undefined);
    sayFound(ctx, scan);
    return { set: total, installed: present, results: [] as SkillSyncResult[] };
  };
  if (!total) return skip();
  if (present === total) {
    ctx.success(`${plural(total, 'Skill')} from your account ${total === 1 ? 'is' : 'are'} installed`);
    return skip();
  }
  ctx.say(`${plural(total, 'Skill')} from your account ${total === 1 ? 'is' : 'are'} set for this Machine (${present} already installed).`);
  if (inTheWay) ctx.warn(`${inTheWay} of them ${inTheWay === 1 ? 'is' : 'are'} blocked by a skill AgentSync didn't install, or edited by hand; see \`agentsync skills status\`.`);
  if (!missing) return skip();
  let wanted = ctx.flags.skills;
  if (wanted === undefined && ctx.canAsk) {
    wanted = (await ctx.select(`Install the other ${missing} now?`, [
      { value: 'yes', label: 'Install them' },
      { value: 'no', label: 'Not now' },
    ], 'yes')) === 'yes';
  }
  if (!wanted) {
    ctx.say('Run `agentsync skills sync` to install them.');
    return skip();
  }
  const { results, reportError, scan } = await syncSkills(ctx, client, payload, false);
  narrate(ctx, results);
  if (reportError) ctx.warn(`Could not tell the server what changed: ${reportError}`);
  sayFound(ctx, scan);
  return { set: total, installed: present, results };
}
