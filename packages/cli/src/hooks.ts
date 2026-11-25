import type { Agent } from './agents.js';
import type { Context } from './context.js';
import { readJson, writeJson } from './files.js';
import { removeOwned, writeOwned } from './owned.js';

type Json = Record<string, unknown>;

/** One hook handler, in the shape Claude Code's settings.json, Codex's hooks.json and Antigravity's hooks.json share. */
export interface Handler {
  type: string;
  command?: string;
  timeout?: number;
}
interface Group {
  matcher?: string;
  hooks?: Handler[];
}

/** Top-level hook name AgentSync writes into Antigravity's `~/.gemini/config/hooks.json`. */
const ANTIGRAVITY_HOOK_NAME = 'agentsync';

/**
 * Seconds before the agent gives up on the hook. The CLI itself waits only ~2s for the
 * server; this is a backstop for a slow Node start.
 */
const HOOK_TIMEOUT_SECONDS = 10;

/** Exactly the handler AgentSync wrote: anything a person changed or wrote themselves is theirs. */
const same = (a: Handler, b: Handler) => a.type === b.type && a.command === b.command && a.timeout === b.timeout;

/** SessionStart groups without the given handlers, dropping groups left empty. */
function groupsWithout(settings: Json, remove: Handler[]): Group[] {
  const hooks = (settings.hooks ?? {}) as Record<string, Group[]>;
  return (hooks.SessionStart ?? []).flatMap((group) => {
    const handlers = group.hooks ?? [];
    const kept = handlers.filter((handler) => !remove.some((removed) => same(handler, removed)));
    if (kept.length === handlers.length) return [group];
    return kept.length ? [{ ...group, hooks: kept }] : [];
  });
}

function withGroups(settings: Json, groups: Group[]): Json {
  const { SessionStart: _, ...events } = (settings.hooks ?? {}) as Record<string, Group[]>;
  const hooks: Record<string, Group[]> = groups.length ? { ...events, SessionStart: groups } : events;
  const { hooks: __, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

/**
 * Add `handler` as a SessionStart hook to an agent's hook config, replacing `previous` (the
 * handler AgentSync installed last time) if it is still there unchanged. Idempotent, and
 * everything else is kept as it was.
 */
export function withHook(settings: Json, handler: Handler, previous?: Handler): Json {
  const remove = previous ? [handler, previous] : [handler];
  return withGroups(settings, [...groupsWithout(settings, remove), { hooks: [handler] }]);
}

/** Remove `handler`, the SessionStart hook AgentSync installed, if it is there unchanged. */
export function withoutHook(settings: Json, handler: Handler): Json {
  const before = ((settings.hooks ?? {}) as Record<string, Group[]>).SessionStart;
  if (!before) return settings;
  return withGroups(settings, groupsWithout(settings, [handler]));
}

const antigravityEntry = (config: Json): Json => {
  const value = config[ANTIGRAVITY_HOOK_NAME];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
};

const flatWithout = (entry: Json, remove: Handler[]): Handler[] => {
  const list = Array.isArray(entry.SessionStart) ? (entry.SessionStart as Handler[]) : [];
  return list.filter((handler) => !remove.some((removed) => same(handler, removed)));
};

function withAntigravityHandlers(config: Json, handlers: Handler[]): Json {
  const entry = antigravityEntry(config);
  const { SessionStart: _, ...entryRest } = entry;
  const nextEntry: Json = handlers.length ? { ...entryRest, SessionStart: handlers } : entryRest;
  const { [ANTIGRAVITY_HOOK_NAME]: __, ...rest } = config;
  return Object.keys(nextEntry).length ? { ...rest, [ANTIGRAVITY_HOOK_NAME]: nextEntry } : rest;
}

/**
 * Add `handler` as a flat `SessionStart` handler under the `"agentsync"` named hook in Antigravity's
 * `hooks.json`, replacing `previous` if it is still there unchanged. Other named hooks and any other
 * fields or handlers inside `"agentsync"` are kept as they were.
 */
export function withAntigravityHook(config: Json, handler: Handler, previous?: Handler): Json {
  const remove = previous ? [handler, previous] : [handler];
  return withAntigravityHandlers(config, [...flatWithout(antigravityEntry(config), remove), handler]);
}

/** Remove `handler` from Antigravity's `"agentsync"` `SessionStart` list if it is there unchanged. */
export function withoutAntigravityHook(config: Json, handler: Handler): Json {
  const entry = antigravityEntry(config);
  if (!Array.isArray(entry.SessionStart)) return config;
  return withAntigravityHandlers(config, flatWithout(entry, [handler]));
}

export const hookHandler = (ctx: Context, agent: Agent): Handler => ({
  type: 'command',
  command: `${ctx.io.self} sync --hook ${agent.id}`,
  timeout: HOOK_TIMEOUT_SECONDS,
});

/**
 * The part of a hook file that runs `command`: `run()` resolves to the line it printed, or `''`.
 *
 * Whatever happens, the promise resolves by the deadline, so the agent always starts. At the
 * deadline it lets go of the command's output pipe, so the agent can still exit, and kills the
 * command's whole process group: killing only the shell would leave the command running.
 */
const runner = (command: string, timeoutMs: number) => `import { type ChildProcess, spawn } from 'node:child_process';

const COMMAND = ${JSON.stringify(command)};
const windows = process.platform === 'win32';

/** Stop the command and everything it started. A failure here must not take the agent down with it. */
function stop(child: ChildProcess) {
  child.stdout?.destroy();
  child.unref();
  if (child.pid === undefined) return;
  try {
    if (windows) {
      // By full path: taskkill is found even when System32 is not on PATH.
      const taskkill = \`\${process.env.SystemRoot || 'C:\\\\Windows'}\\\\System32\\\\taskkill.exe\`;
      const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => {});
      killer.unref();
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {}
}

/** Run the hook. Resolves to its \`AgentSync:\` line, or '' when it printed nothing, failed or ran out of time. */
function run() {
  return new Promise<string>((resolve) => {
    let stdout = '';
    try {
      // Its own process group (on POSIX), so the deadline can stop it as a whole.
      const child = spawn(COMMAND, { shell: true, detached: !windows, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const deadline = setTimeout(() => {
        resolve('');
        stop(child);
      }, ${timeoutMs});
      // Decoded as one stream, so a character split across chunks stays whole.
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => (stdout += chunk));
      child.on('error', () => {
        clearTimeout(deadline);
        resolve('');
      });
      child.on('close', () => {
        clearTimeout(deadline);
        resolve(stdout.trim());
      });
    } catch {
      resolve('');
    }
  });
}`;

/**
 * The pi extension that runs `command`. pi awaits an extension's factory before it reads
 * AGENTS.md, so the session that is starting gets the update. The `AgentSync:` line goes to the
 * person as a notice and to the model at the end of the system prompt.
 */
export const piExtension = (command: string, timeoutMs = HOOK_TIMEOUT_SECONDS * 1000) => `// Written by AgentSync: it syncs your Global Instructions when a pi session starts.
// AgentSync updates this file while it is unchanged, and \`agentsync logout\` removes it.
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
${runner(command, timeoutMs)}

export default async function agentsync(pi: ExtensionAPI) {
  const line = await run();
  if (!line) return;
  pi.on('session_start', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify(line, 'info');
  });
  pi.on('before_agent_start', (event) => ({ systemPrompt: \`\${event.systemPrompt}\\n\\n\${line}\` }));
}
`;

/**
 * The OpenCode plugin that runs `command` when OpenCode starts. One file works in OpenCode 1.x,
 * which calls `server`, and 2.x, which calls `setup`; each ignores the other's. Both await the
 * plugin before the first request, and OpenCode reads AGENTS.md for each request, so the first
 * session gets the update. The `AgentSync:` line goes to the model at the end of the system prompt.
 */
export const opencodePlugin = (command: string, timeoutMs = HOOK_TIMEOUT_SECONDS * 1000) => `// Written by AgentSync: it syncs your Global Instructions when OpenCode starts.
// AgentSync updates this file while it is unchanged, and \`agentsync logout\` removes it.
${runner(command, timeoutMs)}

type SystemPart = { type: 'text'; text: string };
type Session = { hook(name: 'context', run: (event: { system: SystemPart[] }) => void): Promise<unknown> };

export default {
  id: 'agentsync',
  // OpenCode 1.x
  async server() {
    const line = await run();
    if (!line) return {};
    return {
      async 'experimental.chat.system.transform'(_input: unknown, output: { system: string[] }) {
        output.system.push(line);
      },
    };
  },
  // OpenCode 2.x
  async setup(ctx: { session: Session }) {
    const line = await run();
    if (!line) return;
    await ctx.session.hook('context', (event) => {
      event.system.push({ type: 'text', text: line });
    });
  },
};
`;

/** The hook files AgentSync writes whole, for agents without a hook config. */
const hookFiles = {
  'pi-extension': piExtension,
  'opencode-plugin': opencodePlugin,
} satisfies Record<Exclude<Agent['hookKind'], 'json' | 'antigravity-json'>, (command: string) => string>;

/**
 * Install the hook into `agent`'s config (at `homeDir`, or its default home) and remember exactly
 * what was written. Returns false when a hook file was left alone because someone wrote or changed it.
 */
export function installHook(ctx: Context, agent: Agent, homeDir?: string): boolean {
  const file = agent.hooksFile(ctx.io, homeDir);
  const handler = hookHandler(ctx, agent);
  if (agent.hookKind === 'pi-extension' || agent.hookKind === 'opencode-plugin') {
    const written = writeOwned((ctx.config.extensions ??= {}), file, hookFiles[agent.hookKind](handler.command!));
    if (written) ctx.save();
    return written;
  }
  const hooks = (ctx.config.hooks ??= {});
  const apply = agent.hookKind === 'antigravity-json' ? withAntigravityHook : withHook;
  writeJson(file, apply(readJson<Json>(file, {}), handler, hooks[file]), { createMode: 0o600 });
  hooks[file] = handler;
  ctx.save();
  return true;
}

/** Remove every hook AgentSync recorded installing, unless someone changed it since. */
export function uninstallHooks(ctx: Context): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  for (const [file, handler] of Object.entries(ctx.config.hooks ?? {})) {
    const settings = readJson<Json | null>(file, null);
    if (!settings) continue;
    const next = withoutAntigravityHook(withoutHook(settings, handler), handler);
    if (JSON.stringify(next) === JSON.stringify(settings)) continue;
    writeJson(file, next);
    removed.push(file);
  }
  const extensions = removeOwned(ctx.config.extensions ?? {});
  return { removed: [...removed, ...extensions.removed], kept: extensions.kept };
}
