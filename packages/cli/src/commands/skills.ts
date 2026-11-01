import { createHash } from 'node:crypto';
import type { ContractClient, DesiredSkill, SkillSyncResult, SyncPayload } from '@agentsync/contract';
import { findAgent } from '../agents.js';
import type { ManagedSkill } from '../config.js';
import type { Context, Outcome } from '../context.js';
import { describeError, EXIT, usage } from '../exit.js';
import { machineClient } from '../session.js';
import { pendingCounts, planSkills, type SkillStep } from '../skills/plan.js';
import { addSkills, removeSkills } from '../skills/runner.js';
import { scanSkills, type Scan } from '../skills/scan.js';

/** The hook reports an unchanged scan again after this long, so the dashboard knows the Machine checked in. */
const REPORT_EVERY_MS = 24 * 60 * 60 * 1000;

const short = (commit: string) => commit.slice(0, 7);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const recordOf = (skill: DesiredSkill): ManagedSkill => ({ repo: skill.repo, commit: skill.commit, installedHash: skill.installedHash });

/** The `skills` agent names for this Machine's Targets: every agent with a Target gets every Skill. */
const skillsAgents = (payload: SyncPayload) =>
  [...new Set(payload.machine.targets.flatMap((target) => findAgent(target.agent)?.skillsAgent ?? []))];

const scanHash = (scan: Scan) => createHash('sha256').update(JSON.stringify(scan.items)).digest('hex');

/** Send a scan (and `skills sync` results) to the server, and remember it so the hook doesn't send it again. */
async function report(ctx: Context, client: ContractClient, scan: Scan, results?: SkillSyncResult[]) {
  await client.skills.report({ scan: scan.items, ...(results ? { results } : {}) });
  ctx.config.skillsReport = { hash: scanHash(scan), at: Date.now() };
  ctx.save();
}

/**
 * Install, update, adopt and remove Skills so this Machine matches its Pins, through the `skills` CLI.
 * Only AgentSync's own copies are replaced or removed, and drifted ones only with `overwrite`; a folder
 * AgentSync doesn't manage blocks its Skill. Saves the record, then reports the result to the server.
 */
export async function syncSkills(ctx: Context, client: ContractClient, payload: SyncPayload, overwrite: boolean) {
  const managed = (ctx.config.managedSkills ??= {});
  const desired = payload.skills;
  const before = await scanSkills(ctx.io, managed, desired.map((skill) => skill.name));
  const steps = planSkills(desired, before.folders, managed, overwrite);
  const results: SkillSyncResult[] = [];
  const result = (name: string, commit: string, status: SkillSyncResult['status'], error?: string) =>
    results.push({ name, commit, status, ...(error ? { error: error.slice(0, 2000) } : {}) });

  try {
    for (const step of steps) {
      if (step.action === 'adopt' || step.action === 'unchanged') {
        managed[step.name] = recordOf(step.desired);
        result(step.name, step.desired.commit, step.action === 'adopt' ? 'adopted' : 'unchanged');
      } else if (step.action === 'forget') {
        delete managed[step.name];
      } else if (step.action === 'blocked') {
        result(step.name, step.desired.commit, 'blocked');
      } else if (step.action === 'drifted') {
        result(step.name, 'desired' in step ? step.desired.commit : managed[step.name]!.commit, 'drifted');
      }
    }

    const removals = steps.filter((step) => step.action === 'remove').map((step) => step.name);
    if (removals.length) {
      await ctx.during(`Removing ${removals.join(', ')}…`, () => removeSkills(ctx, removals));
      const after = await scanSkills(ctx.io, {}, removals);
      for (const name of removals) {
        const commit = managed[name]!.commit;
        if (after.folders.get(name)?.exists) {
          result(name, commit, 'failed', 'skills remove left it on disk.');
        } else {
          delete managed[name];
          result(name, commit, 'removed');
        }
      }
    }

    const installs = steps.filter((step): step is Extract<SkillStep, { desired: DesiredSkill }> =>
      step.action === 'install' || step.action === 'update' || step.action === 'replace');
    const agents = skillsAgents(payload);
    // One `skills add` per repository and commit: one clone for all its Skills.
    const groups = new Map<string, typeof installs>();
    for (const step of installs) {
      const key = `${step.desired.repo}#${step.desired.commit}`;
      groups.set(key, [...(groups.get(key) ?? []), step]);
    }
    for (const group of groups.values()) {
      const { repo, commit } = group[0]!.desired;
      const names = group.map((step) => step.name);
      if (!agents.length) {
        for (const name of names) result(name, commit, 'failed', 'No agent on this Machine takes Skills: AgentSync installs them for Claude Code, Codex and pi.');
        continue;
      }
      let outcome: Awaited<ReturnType<typeof addSkills>> | Error;
      try {
        outcome = await ctx.during(`Installing ${names.join(', ')} from ${repo}…`, () => addSkills(ctx, repo, commit, names, agents));
      } catch (error) {
        outcome = error instanceof Error ? error : new Error(String(error));
      }
      const after = await scanSkills(ctx.io, {}, names);
      for (const step of group) {
        const folder = after.folders.get(step.name);
        const said = outcome instanceof Error ? { ok: false as const, error: describeError(outcome) } : outcome.get(step.name);
        const failure = said && !said.ok ? said.error : null;
        if (!folder?.exists) {
          result(step.name, commit, 'failed', failure ?? 'skills add did not install it.');
          continue;
        }
        // `skills` wrote it, so it is AgentSync's now, matching or not; a mismatch then reads as Drift.
        managed[step.name] = recordOf(step.desired);
        if (folder.hash !== step.desired.installedHash) {
          result(step.name, commit, 'failed', 'The installed folder does not match its Pin.');
        } else {
          result(step.name, commit, step.action === 'install' ? 'installed' : 'updated');
        }
      }
    }
  } finally {
    ctx.save();
  }

  let reportError: string | undefined;
  try {
    await report(ctx, client, await scanSkills(ctx.io, managed), results);
  } catch (error) {
    reportError = describeError(error);
  }
  return { results, reportError };
}

/** Say what happened to each Skill, and why anything was left alone. */
function narrate(ctx: Context, results: SkillSyncResult[]) {
  for (const { name, commit, status, error } of results) {
    if (status === 'installed') ctx.say(`Installed ${name} @ ${short(commit)}`);
    else if (status === 'updated') ctx.say(`Updated ${name} to ${short(commit)}`);
    else if (status === 'adopted') ctx.detail(`${name} was already installed at its Pin; AgentSync manages it now.`);
    else if (status === 'removed') ctx.say(`Removed ${name}`);
    else if (status === 'failed') ctx.warn(`Could not install ${name}: ${error}`);
    else if (status === 'blocked') ctx.warn(`${name} is blocked by your own skill of that name. AgentSync leaves it alone; remove or rename it to get the Skill.`);
    else if (status === 'drifted') ctx.warn(`${name} was edited by hand, so it was left alone. Run \`agentsync skills sync --overwrite\` to replace it.`);
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
  blocked: 'Blocked by your own skill',
  remove: 'To remove',
  forget: 'Gone',
} as const;

/** `skills status`: each Skill on this Machine against its Pin, without changing anything. */
async function skillsStatus(ctx: Context): Promise<Outcome> {
  const payload = await ctx.during('Fetching your Skills…', () => machineClient(ctx).machines.sync());
  const managed = ctx.config.managedSkills ?? {};
  const { folders } = await scanSkills(ctx.io, managed, payload.skills.map((skill) => skill.name));
  const steps = planSkills(payload.skills, folders, managed, false).filter((step) => step.action !== 'forget');
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

/** The hook's words for what `skills sync` would do, or `null` if nothing. */
function pendingText(steps: SkillStep[]): string | null {
  const { install, update, remove } = pendingCounts(steps);
  const parts = [
    install && `${plural(install, 'Skill')} to install`,
    update && plural(update, 'update'),
    remove && `${remove} to remove`,
  ].filter(Boolean);
  return parts.length ? `${parts.join(', ')}; run \`agentsync skills sync\`` : null;
}

/**
 * The hook's part: scan (in-process, tens of milliseconds), report the scan if it changed or a day
 * passed, and say what `skills sync` would do once `payload` arrives. It never installs anything and
 * never throws: a failure only means no line and no report this time.
 */
export async function hookSkills(ctx: Context, client: ContractClient, payload: Promise<SyncPayload>): Promise<string | null> {
  try {
    const managed = ctx.config.managedSkills ?? {};
    const scan = await scanSkills(ctx.io, managed);
    const last = ctx.config.skillsReport;
    const due = !last || last.hash !== scanHash(scan) || Date.now() - last.at >= REPORT_EVERY_MS;
    const sent = due ? report(ctx, client, scan).catch(() => undefined) : Promise.resolve();
    let line: string | null = null;
    try {
      const { skills: desired } = await payload;
      // Names the listing didn't see are simply absent: they count as to install.
      line = pendingText(planSkills(desired, scan.folders, managed, false));
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
  const managed = (ctx.config.managedSkills ??= {});
  const scan = await scanSkills(ctx.io, managed, payload.skills.map((skill) => skill.name));
  const steps = planSkills(payload.skills, scan.folders, managed, false);
  for (const step of steps) if (step.action === 'adopt') managed[step.name] = recordOf(step.desired);
  ctx.save();
  const { install, update } = pendingCounts(steps);
  const missing = install + update;
  const present = steps.filter((step) => step.action === 'adopt' || step.action === 'unchanged').length;
  const inTheWay = steps.filter((step) => step.action === 'blocked' || step.action === 'drifted').length;
  const total = payload.skills.length;
  const skip = async () => {
    await report(ctx, client, await scanSkills(ctx.io, managed)).catch(() => undefined);
    return { set: total, installed: present, results: [] as SkillSyncResult[] };
  };
  if (!total) return skip();
  if (present === total) {
    ctx.success(`${plural(total, 'Skill')} from your account ${total === 1 ? 'is' : 'are'} installed`);
    return skip();
  }
  ctx.say(`${plural(total, 'Skill')} from your account ${total === 1 ? 'is' : 'are'} set for this Machine (${present} already installed).`);
  if (inTheWay) ctx.warn(`${inTheWay} of them ${inTheWay === 1 ? 'is' : 'are'} blocked by your own skill or edited by hand; see \`agentsync skills status\`.`);
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
