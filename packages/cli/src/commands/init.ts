import { isAbsolute } from 'node:path';
import type { ContractClient, DeviceAuthorization, MachineOs, Target } from '@agentsync/contract';
import { referencedVariables } from '@agentsync/template';
import { ORPCError } from '@orpc/client';
import { AGENTS, type Agent, detectAgents, findAgent, targetFor } from '../agents.js';
import { connect, normaliseServer } from '../client.js';
import type { PendingLogin } from '../config.js';
import type { Context, Outcome } from '../context.js';
import { CliError, EXIT, usage } from '../exit.js';
import { readText } from '../files.js';
import { installHook } from '../hooks.js';
import { expandHome, tildify } from '../paths.js';
import { machineClient } from '../session.js';
import { installSkill } from '../skill.js';
import { checkedNickname, nicknameCheck } from '../nickname.js';
import { changeVariables, parseAssignments } from '../variables.js';
import { applySync } from './sync.js';

export function machineOs(platform: NodeJS.Platform): MachineOs {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/**
 * The Targets to register: `--agent`/`--target` if given, otherwise the detected agents. At a
 * terminal, a person picks among the known agents, with the detected ones already selected.
 */
async function chooseTargets(ctx: Context): Promise<Target[]> {
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
    const path = expandHome(match[2]!, io);
    // Hooks run in whatever project the agent opens, so a relative path would mean a different file each time.
    if (!isAbsolute(path)) throw usage(`--target paths must be absolute or start with ~/, not "${match[2]}".`);
    targets.push({ agent: match[1]!, path: tildify(path, io) });
  }
  if (!flags.agent.length && !flags.target.length) {
    const detected = detectAgents(io).map((agent) => agent.id);
    const picked = ctx.canAsk
      ? await ctx.multiselect(
          'Which agents should AgentSync keep in sync?',
          AGENTS.map((agent) => ({
            value: agent.id,
            label: agent.name,
            hint: `${tildify(agent.instructions(io), io)}${detected.includes(agent.id) ? '' : ', not found here'}`,
          })),
          detected,
        )
      : detected;
    targets.push(...AGENTS.filter((agent) => picked.includes(agent.id)).map((agent) => targetFor(agent, io)));
  }
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

/** The pending registration for `server`, if it has not expired. */
const pendingFor = (ctx: Context, server: string) => {
  const { pending } = ctx.config;
  return pending && pending.server === server && pending.expiresAt > Date.now() ? pending : undefined;
};

/**
 * The nickname for a new registration: `--name`, else the one a pending registration saved,
 * else asked at a terminal with the hostname prefilled, else the hostname.
 */
async function chooseNickname(ctx: Context, server: string): Promise<string> {
  if (ctx.flags.name !== undefined) return checkedNickname(ctx.flags.name);
  const saved = pendingFor(ctx, server)?.name;
  if (saved) return saved;
  const check = await nicknameCheck();
  const hostname = ctx.io.hostname.trim();
  if (ctx.canAsk) return ctx.text('Machine nickname', { initial: hostname, validate: check });
  if (check(hostname)) throw usage(`The hostname "${hostname}" cannot be a Machine nickname. Pass --name <nickname>.`);
  return hostname;
}

/** Register this Machine with the device flow, or resume one that `--no-wait` started. */
async function register(ctx: Context, server: string, targets: Target[], name: string): Promise<Outcome | null> {
  const { io, config } = ctx;
  const client = connect(io, server);
  let pending = pendingFor(ctx, server);
  if (!pending) {
    const started: DeviceAuthorization = await client.machines.deviceStart();
    pending = {
      server,
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUriComplete: started.verificationUriComplete,
      interval: started.interval,
      expiresAt: Date.now() + started.expiresIn * 1000,
      name,
    } satisfies PendingLogin;
    config.pending = pending;
    ctx.save();
  } else if (pending.name !== name) {
    pending.name = name;
    ctx.save();
  }
  ctx.say(`To register this Machine, approve it in the browser.\n\nOpen: ${pending.verificationUriComplete}\nCode: ${pending.userCode}\n`);
  const shown = { userCode: pending.userCode, verificationUri: pending.verificationUriComplete };
  if (!ctx.flags.wait) {
    ctx.say('Run `agentsync init` again once you have approved it.');
    return { data: { status: 'pending', ...shown } };
  }

  return ctx.during('Waiting for browser approval…', () => poll(ctx, client, pending, name, targets));
}

async function poll(
  ctx: Context,
  client: ReturnType<typeof connect>,
  pending: PendingLogin,
  name: string,
  targets: Target[],
): Promise<null> {
  const { io, config } = ctx;
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
      config.server = pending.server;
      config.token = result.token;
      config.machineId = result.machine.id;
      ctx.save();
      ctx.success(`Registered Machine ${result.machine.name}`);
      return null;
    }
    ctx.save();
    const reason = {
      denied: 'The registration was denied.',
      expired: 'The registration code expired.',
      invalid: 'The registration code is no longer valid.',
    }[result.status];
    throw new CliError(`${reason} Run \`agentsync init\` to start again.`, EXIT.auth, { status: result.status });
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
  ctx.success(`Imported ${source.path} as the first Template revision`);
  return source.path;
}

/** At a terminal, ask for the Variables the Template uses that this Machine has not set. */
async function askForVariables(ctx: Context, client: ContractClient, machineId: string): Promise<void> {
  const [template, current] = await Promise.all([client.template.get(), client.variables.get({ machineId })]);
  const missing = referencedVariables(template.text).filter((name) => !(name in current.variables));
  const answers: Record<string, string> = {};
  for (const name of missing) {
    const value = await ctx.text(`Value of {{${name}}} on this Machine (leave empty to keep it unset)`);
    if (value) answers[name] = value;
  }
  if (Object.keys(answers).length) await changeVariables(client, machineId, answers);
}

/** Register this Machine (if needed), then set up its Variables, Template, hooks and skill, and sync. */
export async function init(ctx: Context): Promise<Outcome> {
  const server = chooseServer(ctx);
  if (ctx.config.token && ctx.config.server !== server) {
    throw usage(`This Machine is registered with ${ctx.config.server}. Run \`agentsync logout\` first.`);
  }
  const alreadyRegistered = !!ctx.config.token;
  // An explicit --name renames a registered Machine; an ordinary init keeps the server's nickname.
  const rename = alreadyRegistered && ctx.flags.name !== undefined ? await checkedNickname(ctx.flags.name) : undefined;
  const nickname = alreadyRegistered ? undefined : await chooseNickname(ctx, server);
  const chosen = await chooseTargets(ctx);
  const set = parseAssignments(ctx.flags.var);
  if (nickname !== undefined) {
    const early = await register(ctx, server, chosen, nickname);
    if (early) return early;
  }
  const client = machineClient(ctx);
  const machineId = ctx.config.machineId!;

  let { machine } = await client.machines.sync();
  const added = chosen.filter((target) => !machine.targets.some((known) => known.path === target.path));
  const changes = {
    ...(alreadyRegistered && added.length ? { targets: [...machine.targets, ...added] } : {}),
    ...(rename !== undefined && rename !== machine.name ? { name: rename } : {}),
  };
  if (Object.keys(changes).length) machine = await client.machines.update({ machineId, ...changes });
  if (changes.name) ctx.success(`Machine nickname saved: ${machine.name}`);
  if (Object.keys(set).length) await changeVariables(client, machineId, set);
  const { revision } = await client.template.get();
  const imported = revision === 0 ? await importExisting(ctx, client, machine.targets) : undefined;
  if (ctx.canAsk) await askForVariables(ctx, client, machineId);

  const agents = [...new Set(machine.targets.map((target) => findAgent(target.agent)))].filter(
    (agent): agent is Agent => !!agent,
  );
  const hooks: string[] = [];
  const skills: string[] = [];
  const skillsLeftAlone: string[] = [];
  for (const agent of agents) {
    if (ctx.flags.hooks) {
      installHook(ctx, agent);
      hooks.push(tildify(agent.hooksFile(ctx.io), ctx.io));
      ctx.detail(`Installed the ${agent.name} SessionStart hook in ${tildify(agent.hooksFile(ctx.io), ctx.io)}.`);
    }
    if (ctx.flags.skill) {
      const { file, written } = installSkill(ctx, agent);
      const list = written ? skills : skillsLeftAlone;
      if (!list.includes(tildify(file, ctx.io))) list.push(tildify(file, ctx.io));
    }
  }
  if (skills.length) ctx.detail(`Installed the agentsync skill in ${skills.join(', ')}.`);
  const installed = [hooks.length && 'hooks', skills.length && 'the agentsync skill'].filter(Boolean).join(' and ');
  if (installed) ctx.success(`Installed ${installed} for ${agents.map((agent) => agent.name).join(', ')}`);
  if (hooks.length && agents.some((agent) => agent.id === 'codex')) {
    ctx.warn('Codex: open Codex, run /hooks and trust the new hook. It runs only once you do.');
  }
  for (const file of skillsLeftAlone) {
    ctx.warn(`Left ${file} alone: AgentSync did not write it, or it was changed since. Remove it to get the agentsync skill.`);
  }

  const { code, data } = await applySync(ctx, await client.machines.sync());
  return { code: code ?? EXIT.ok, data: { machineId, name: machine.name, imported, hooks, skills, skillsLeftAlone, ...data } };
}
