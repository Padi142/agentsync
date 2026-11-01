import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  desiredSkillSchema, gitShaSchema, RESERVED_SKILL_NAME, skillNameSchema, type ContractClient, type DesiredSkill, type SkillSyncResult, type SyncPayload,
} from '@agentsync/contract';
import { findAgent } from '../agents.js';
import type { Context, Outcome } from '../context.js';
import { describeError, EXIT, usage } from '../exit.js';
import { machineClient } from '../session.js';
import { foreign, pendingCounts, planSkills, requiredPlaces, type SkillStep } from '../skills/plan.js';
import { addSkills, removeSkills } from '../skills/runner.js';
import { forgetLockEntry, scanSkills, skillDir, type Scan } from '../skills/scan.js';
import { readSkillsState, recordOf, updateSkillsState, withSkillsLock, type ManagedSkill, type Place } from '../skills/state.js';

/** The hook reports an unchanged scan again after this long, so the dashboard knows the Machine checked in. */
const REPORT_EVERY_MS = 24 * 60 * 60 * 1000;

const short = (commit: string) => commit.slice(0, 7);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The `skills` agent names for this Machine's Targets: every agent with a Target gets every Skill. */
const skillsAgents = (payload: SyncPayload) =>
  [...new Set(payload.machine.targets.flatMap((target) => findAgent(target.agent)?.skillsAgent ?? []))];

/**
 * The agents to pass `skills add` so it writes every directory the Skill needs, and keeps every
 * directory AgentSync already owns in step (a stale copy there would read as Drift).
 */
function installAgents(agents: readonly string[], owned: readonly Place[]): string[] {
  const all = new Set(agents);
  if (owned.includes('claude')) all.add('claude-code');
  if (owned.includes('agents') && ![...all].some((agent) => agent !== 'claude-code')) all.add('codex');
  return [...all];
}

const scanHash = (scan: Scan) => createHash('sha256').update(JSON.stringify(scan.items)).digest('hex');

/** Send a scan (and `skills sync` results), and remember it so the hook doesn't send it again. */
async function report(ctx: Context, client: ContractClient, scan: Scan, results?: SkillSyncResult[], until?: number) {
  // A result for a name the server couldn't have sent validly is the person's to see, not the server's.
  const valid = results?.filter((result) => skillNameSchema.safeParse(result.name).success);
  await client.skills.report({ scan: scan.items, ...(valid ? { results: valid } : {}) });
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
    // The CLI's own skill is never a Skill, whatever the server says.
    if (skill.name !== RESERVED_SKILL_NAME && desiredSkillSchema.safeParse(skill).success) {
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
 */
export async function syncSkills(ctx: Context, client: ContractClient, payload: SyncPayload, overwrite: boolean) {
  const { io } = ctx;
  return withSkillsLock(io, async () => {
    const { managed } = readSkillsState(io);
    const { valid: desired, invalid, keep } = checkedDesired(payload);
    const results: SkillSyncResult[] = [...invalid];
    const result = (name: string, commit: string, status: SkillSyncResult['status'], error?: string) =>
      results.push({ name, commit, status, ...(error ? { error: error.slice(0, 2000) } : {}) });
    const agents = skillsAgents(payload);
    const required = requiredPlaces(agents);
    /** Plan `names` again from the disk as it is now. */
    const replan = async (names: string[]) => {
      const now = await scanSkills(io, managed, names, { only: true });
      return planSkills(desired.filter((skill) => names.includes(skill.name)), now.folders, managed, required, overwrite, keep)
        .filter((step) => names.includes(step.name));
    };
    const settle = (step: SkillStep) => {
      const commit = 'desired' in step ? step.desired.commit : step.record.commit;
      if (step.action === 'adopt' && 'desired' in step) {
        managed[step.name] = recordFor(step.desired, step.present);
        result(step.name, commit, 'adopted');
      } else if (step.action === 'unchanged' && 'desired' in step) {
        managed[step.name] = { ...recordFor(step.desired, recordOf(managed, step.name)!.places) };
        result(step.name, commit, 'unchanged');
      } else if (step.action === 'forget') {
        delete managed[step.name];
      } else if (step.action === 'blocked' || step.action === 'drifted') {
        result(step.name, commit, step.action);
      }
    };

    try {
      const steps = planSkills(desired, (await scanSkills(io, managed, desired.map((skill) => skill.name))).folders, managed, required, overwrite, keep);
      for (const step of steps) settle(step);

      const removals = steps.filter((step) => step.action === 'remove').map((step) => step.name);
      if (removals.length) {
        const still = await replan(removals);
        for (const step of still) if (step.action !== 'remove') settle(step);
        const names = still.filter((step) => step.action === 'remove').map((step) => step.name);
        if (names.length) {
          await ctx.during(`Removing ${names.join(', ')}…`, () => removeSkills(ctx, names));
          // Hashed against AgentSync's records, so a copy edited since the plan is never deleted below.
          const after = await scanSkills(io, managed, names, { only: true });
          for (const name of names) {
            const record = recordOf(managed, name)!;
            const leftover = after.folders.get(name);
            let left = leftover?.present ?? [];
            // `skills` keeps the shared `~/.agents/skills` copy while another agent it knows (Cursor, say)
            // reads that directory. If it's still AgentSync's unedited copy, finish the removal here.
            const ours = leftover !== undefined && !foreign(leftover, record) &&
              (overwrite || leftover.hash === record.installedHash);
            if (left.length && ours) {
              for (const place of left) await rm(join(skillDir(io, place), name), { recursive: true, force: true });
              await forgetLockEntry(io, name);
              left = (await scanSkills(io, {}, [name], { only: true })).folders.get(name)?.present ?? [];
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
        if (!agents.length) {
          for (const step of group) result(step.name, commit, 'failed', 'No agent on this Machine takes Skills: AgentSync installs them for Claude Code, Codex and pi.');
          continue;
        }
        // The disk may have changed while earlier groups installed: act only on what still holds.
        const fresh = await replan(group.map((step) => step.name));
        const go = fresh.filter((step): step is Extract<SkillStep, { desired: DesiredSkill }> =>
          step.action === 'install' || step.action === 'update' || step.action === 'replace');
        for (const step of fresh) if (!go.includes(step as never)) settle(step);
        if (!go.length) continue;
        const names = go.map((step) => step.name);
        const owned = [...new Set(go.flatMap((step) => recordOf(managed, step.name)?.places ?? []))];
        const targets = installAgents(agents, owned);
        let outcome: Awaited<ReturnType<typeof addSkills>> | Error;
        try {
          outcome = await ctx.during(`Installing ${names.join(', ')} from ${repo}…`, () => addSkills(ctx, repo, commit, names, targets));
        } catch (error) {
          outcome = error instanceof Error ? error : new Error(String(error));
        }
        const wrote = requiredPlaces(targets);
        const after = await scanSkills(io, {}, names, { only: true });
        for (const step of go) {
          const folder = after.folders.get(step.name);
          const said = outcome instanceof Error ? { ok: false as const, error: describeError(outcome) } : outcome.get(step.name);
          const placed = wrote.filter((place) => folder?.present.includes(place));
          const before = recordOf(managed, step.name);
          const present = folder?.present ?? [];
          if (folder?.hash === step.desired.installedHash) {
            managed[step.name] = recordFor(step.desired, present);
          } else if (before && present.every((place) => before.places.includes(place)) && folder?.hash === before.installedHash) {
            // Nothing was written: the copy is still the earlier Pin, and stays recorded as that.
          } else if (present.length) {
            // `skills` wrote part of it: AgentSync's, and the next sync finishes it without --overwrite.
            managed[step.name] = { ...recordFor(step.desired, [...new Set([...(before?.places ?? []), ...placed])]), incomplete: true };
          }
          if (said && !said.ok) result(step.name, commit, 'failed', said.error);
          else if (placed.length !== wrote.length) result(step.name, commit, 'failed', 'skills add didn’t write every agent’s copy.');
          else if (folder?.hash !== step.desired.installedHash) result(step.name, commit, 'failed', 'The installed folder does not match its Pin.');
          else result(step.name, commit, step.action === 'install' ? 'installed' : 'updated');
        }
      }
    } finally {
      updateSkillsState(io, (state) => { state.managed = managed; });
    }

    let reportError: string | undefined;
    try {
      await report(ctx, client, await scanSkills(io, managed), results);
    } catch (error) {
      reportError = describeError(error);
    }
    return { results, reportError };
  });
}

/** AgentSync's record of a Skill it wrote or adopted in `places`. */
function recordFor(skill: DesiredSkill, places: readonly Place[]): ManagedSkill {
  return { repo: skill.repo, commit: skill.commit, installedHash: skill.installedHash, sources: skill.sources, places: [...places] };
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
  const { results, reportError } = await syncSkills(ctx, client, payload, ctx.flags.overwrite);
  narrate(ctx, results);
  if (reportError) ctx.warn(`Could not tell the server what changed: ${reportError}`);
  const has = (...statuses: SkillSyncResult['status'][]) => results.some((result) => statuses.includes(result.status));
  if (!has('failed', 'blocked', 'drifted')) {
    const changed = results.filter((result) => ['installed', 'updated', 'removed'].includes(result.status)).length;
    const count = payload.skills.length;
    ctx.success(changed ? `Skills synced · ${plural(changed, 'change')}`
      : count ? `${count === 1 ? 'The Skill is' : `All ${count} Skills are`} up to date` : 'No Skills are set for this Machine');
  }
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
  const { managed } = readSkillsState(ctx.io);
  const { valid: desired, keep } = checkedDesired(payload);
  const { folders } = await scanSkills(ctx.io, managed, desired.map((skill) => skill.name));
  return planSkills(desired, folders, managed, requiredPlaces(skillsAgents(payload)), false, keep).filter((step) => step.action !== 'forget');
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
  if (rest.length) throw usage(`Unexpected argument "${rest[0]}". Run agentsync help skills for usage.`);
  if (action === 'sync') return skillsSync(ctx);
  if (action === 'status') return skillsStatus(ctx);
  throw usage(action ? `Unknown action "skills ${action}". Use skills sync or skills status.` : 'Use agentsync skills sync or agentsync skills status.');
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
    const { managed, report: last } = readSkillsState(ctx.io);
    const scan = await scanSkills(ctx.io, managed, [], { deadline });
    const due = !last || last.hash !== scanHash(scan) || Date.now() - last.at >= REPORT_EVERY_MS;
    const remaining = deadline - Date.now();
    const sent = due && remaining > 0
      ? report(ctx, machineClient(ctx, remaining), scan, undefined, deadline).catch(() => undefined)
      : Promise.resolve();
    let line: string | null = null;
    try {
      const resolved = await payload;
      const { valid: desired, keep } = checkedDesired(resolved);
      // Names the listing didn't see are simply absent: they count as to install.
      line = pendingText(planSkills(desired, scan.folders, managed, requiredPlaces(skillsAgents(resolved)), false, keep));
    } catch {
      // The Template part reports why the server could not be reached.
    }
    await sent;
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
  const required = requiredPlaces(skillsAgents(payload));
  const steps = await withSkillsLock(io, async () => {
    const { managed } = readSkillsState(io);
    const planned = planSkills(desired, (await scanSkills(io, managed, desired.map((skill) => skill.name))).folders, managed, required, false);
    const adopted = planned.filter((step) => step.action === 'adopt' && 'desired' in step);
    if (adopted.length) {
      updateSkillsState(io, (state) => {
        for (const step of adopted) if ('desired' in step) state.managed[step.name] = recordFor(step.desired, step.present);
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
    await report(ctx, client, await scanSkills(io, readSkillsState(io).managed)).catch(() => undefined);
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
  const { results, reportError } = await syncSkills(ctx, client, payload, false);
  narrate(ctx, results);
  if (reportError) ctx.warn(`Could not tell the server what changed: ${reportError}`);
  return { set: total, installed: present, results };
}
