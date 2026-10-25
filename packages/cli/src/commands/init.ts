import type { ContractClient, DeviceAuthorization, MachineOs, Target } from '@agentsync/contract';
import { referencedVariables } from '@agentsync/template';
import { ORPCError } from '@orpc/client';
import { type Agent, detectAgents, findAgent, targetFor } from '../agents.js';
import { connect, normaliseServer } from '../client.js';
import type { PendingLogin } from '../config.js';
import type { Context, Outcome } from '../context.js';
import { CliError, EXIT, usage } from '../exit.js';
import { readText } from '../files.js';
import { installHook } from '../hooks.js';
import { expandHome, tildify } from '../paths.js';
import { machineClient } from '../session.js';
import { installSkill } from '../skill.js';
import { changeVariables, parseAssignments } from '../variables.js';
import { applySync } from './sync.js';

export function machineOs(platform: NodeJS.Platform): MachineOs {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/** The Targets to register: `--agent`/`--target` if given, otherwise every detected agent. */
function chooseTargets(ctx: Context): Target[] {
  const { flags, io } = ctx;
  const targets: Target[] = [];
  for (const id of flags.agent) {
    const agent = findAgent(id);
    if (!agent) throw usage(`Unknown agent "${id}". Known agents: claude, codex. Use --target for others.`);
    targets.push(targetFor(agent, io));
  }
  for (const value of flags.target) {
    const match = /^([a-z][a-z0-9-]*)=(.+)$/.exec(value);
    if (!match) throw usage(`--target must look like <agent>=<path>, e.g. gemini=~/.gemini/GEMINI.md.`);
    targets.push({ agent: match[1]!, path: tildify(expandHome(match[2]!, io), io) });
  }
  if (!flags.agent.length && !flags.target.length) targets.push(...detectAgents(io).map((agent) => targetFor(agent, io)));
  if (!targets.length) {
    throw usage('No agents found on this Machine. Pass --agent claude, --agent codex, or --target <agent>=<path>.');
  }
  return targets;
}

function chooseServer(ctx: Context): string {
  const value = ctx.flags.server ?? ctx.config.server ?? ctx.config.pending?.server ?? ctx.io.env.AGENTSYNC_SERVER;
  if (!value) throw usage('No AgentSync server configured. Pass --server <url>.');
  const server = normaliseServer(value);
  if (!server) throw usage(`"${value}" is not an http(s) URL.`);
  return server;
}

/** Register this Machine with the device flow, or resume one that `--no-wait` started. */
async function register(ctx: Context, server: string, targets: Target[]): Promise<Outcome | null> {
  const { io, config } = ctx;
  const client = connect(io, server);
  let pending = config.pending;
  if (!pending || pending.server !== server || pending.expiresAt <= Date.now()) {
    const started: DeviceAuthorization = await client.machines.deviceStart();
    pending = {
      server,
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUriComplete: started.verificationUriComplete,
      interval: started.interval,
      expiresAt: Date.now() + started.expiresIn * 1000,
    } satisfies PendingLogin;
    config.pending = pending;
    ctx.save();
  }
  ctx.say(`To register this Machine, open ${pending.verificationUriComplete}`);
  ctx.say(`and confirm the code ${pending.userCode}.`);
  const shown = { userCode: pending.userCode, verificationUri: pending.verificationUriComplete };
  if (!ctx.flags.wait) {
    ctx.say('Run `agentsync init` again once you have approved it.');
    return { data: { status: 'pending', ...shown } };
  }

  const name = (ctx.flags.name ?? io.hostname).trim() || 'machine';
  let interval = pending.interval;
  for (;;) {
    await io.sleep(interval * 1000);
    const result = await client.machines.devicePoll({
      deviceCode: pending.deviceCode,
      name,
      os: machineOs(io.platform),
      targets,
    });
    if (result.status === 'pending') {
      interval = result.interval;
      continue;
    }
    delete config.pending;
    if (result.status === 'approved') {
      config.server = server;
      config.token = result.token;
      config.machineId = result.machine.id;
      ctx.save();
      ctx.say(`Registered this Machine as "${result.machine.name}".`);
      return null;
    }
    ctx.save();
    const reason = {
      denied: 'The registration was denied.',
      expired: 'The registration code expired.',
      invalid: 'The registration code is no longer valid.',
    }[result.status];
    throw new CliError(`${reason} Run \`agentsync init\` to start again.`, EXIT.auth, { status: result.status, ...shown });
  }
}

/** Make a file's text into a Template that Renders back to exactly that text: every `{{` stays literal. */
export const escapeTemplate = (text: string) => text.replaceAll('{{', '\\{{');

/**
 * On the first Machine of an account (Template revision 0), save an existing file as
 * revision 1: `--import <path>`, or else the largest existing Target. Returns its path.
 */
async function importExisting(ctx: Context, client: ContractClient, targets: Target[]): Promise<string | undefined> {
  const candidates = ctx.flags.import ? [tildify(expandHome(ctx.flags.import, ctx.io), ctx.io)] : targets.map((t) => t.path);
  const [source] = candidates
    .map((path) => ({ path, text: readText(expandHome(path, ctx.io)) }))
    .filter((file): file is { path: string; text: string } => !!file.text?.trim())
    .sort((a, b) => b.text.length - a.text.length);
  if (!source) {
    if (ctx.flags.import) throw usage(`${ctx.flags.import} does not exist or is empty.`);
    return undefined;
  }
  try {
    await client.template.put({ text: escapeTemplate(source.text), expectedRevision: 0 });
  } catch (error) {
    // Another Machine imported first. Its Template wins, and this file is handled as Drift.
    if (error instanceof ORPCError && error.code === 'CONFLICT') return undefined;
    throw error;
  }
  ctx.say(`Imported ${source.path} as the first Template revision.`);
  return source.path;
}

/** At a terminal, ask for the Variables the Template uses that this Machine has not set. */
async function askForVariables(ctx: Context, client: ContractClient, machineId: string): Promise<void> {
  const [template, current] = await Promise.all([client.template.get(), client.variables.get({ machineId })]);
  const missing = referencedVariables(template.text).filter((name) => !(name in current.variables));
  const answers: Record<string, string> = {};
  for (const name of missing) {
    const value = await ctx.io.ask(`Value of {{${name}}} on this Machine (empty to leave unset): `);
    if (value) answers[name] = value;
  }
  if (Object.keys(answers).length) await changeVariables(client, machineId, answers);
}

/** Register this Machine (if needed), then set up its Variables, Template, hooks and skill, and sync. */
export async function init(ctx: Context): Promise<Outcome> {
  const server = chooseServer(ctx);
  const chosen = chooseTargets(ctx);
  const set = parseAssignments(ctx.flags.var);
  if (ctx.config.token && ctx.config.server !== server) {
    throw usage(`This Machine is registered with ${ctx.config.server}. Run \`agentsync logout\` first.`);
  }
  const alreadyRegistered = !!ctx.config.token;
  if (!alreadyRegistered) {
    const early = await register(ctx, server, chosen);
    if (early) return early;
  }
  const client = machineClient(ctx);
  const machineId = ctx.config.machineId!;

  let { machine } = await client.machines.sync();
  const added = chosen.filter((target) => !machine.targets.some((known) => known.path === target.path));
  if (alreadyRegistered && added.length) {
    machine = await client.machines.update({ machineId, targets: [...machine.targets, ...added] });
  }
  if (Object.keys(set).length) await changeVariables(client, machineId, set);
  const { revision } = await client.template.get();
  const imported = revision === 0 ? await importExisting(ctx, client, machine.targets) : undefined;
  if (ctx.canAsk) await askForVariables(ctx, client, machineId);

  const agents = [...new Set(machine.targets.map((target) => findAgent(target.agent)))].filter(
    (agent): agent is Agent => !!agent,
  );
  const hooks: string[] = [];
  const skills: string[] = [];
  for (const agent of agents) {
    if (ctx.flags.hooks) {
      installHook(ctx.io, agent);
      hooks.push(tildify(agent.hooksFile(ctx.io), ctx.io));
      ctx.say(`Installed the ${agent.name} SessionStart hook in ${tildify(agent.hooksFile(ctx.io), ctx.io)}.`);
      if (agent.id === 'codex') ctx.say('Codex runs it only once you trust it: open Codex and run /hooks.');
    }
    if (ctx.flags.skill) {
      const file = tildify(installSkill(ctx.io, agent), ctx.io);
      if (!skills.includes(file)) skills.push(file);
    }
  }
  if (skills.length) ctx.say(`Installed the agentsync skill in ${skills.join(', ')}.`);

  const { code, data } = await applySync(ctx, await client.machines.sync());
  return { code: code ?? EXIT.ok, data: { machineId, name: machine.name, imported, hooks, skills, ...data } };
}
