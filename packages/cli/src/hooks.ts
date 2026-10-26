import type { Agent } from './agents.js';
import type { Context } from './context.js';
import { readJson, writeJson } from './files.js';
import { removeOwned, writeOwned } from './owned.js';

type Json = Record<string, unknown>;

/** One hook handler, in the shape Claude Code's settings.json and Codex's hooks.json share. */
export interface Handler {
  type: string;
  command?: string;
  timeout?: number;
}
interface Group {
  matcher?: string;
  hooks?: Handler[];
}

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

export const hookHandler = (ctx: Context, agent: Agent): Handler => ({
  type: 'command',
  command: `${ctx.io.self} sync --hook ${agent.id}`,
  timeout: HOOK_TIMEOUT_SECONDS,
});

/**
 * The pi extension that runs `command`. pi awaits an extension's factory before it reads
 * AGENTS.md, so the session that is starting gets the update. The `AgentSync:` line goes to the
 * person as a notice and to the model at the end of the system prompt.
 *
 * Whatever happens, the promise resolves by the deadline, so pi always starts. At the deadline
 * the extension lets go of the command's output pipe, so pi can still exit, and kills the
 * command's whole process group: killing only the shell would leave the command running.
 */
export const piExtension = (command: string, timeoutMs = HOOK_TIMEOUT_SECONDS * 1000) => `// Written by AgentSync: it syncs your Global Instructions when a pi session starts.
// AgentSync updates this file while it is unchanged, and \`agentsync logout\` removes it.
import { type ChildProcess, spawn } from 'node:child_process';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

const COMMAND = ${JSON.stringify(command)};
const windows = process.platform === 'win32';

/** Stop the command and everything it started. A failure here must not take pi down with it. */
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

export default async function agentsync(pi: ExtensionAPI) {
  const line = await new Promise<string>((resolve) => {
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
  if (!line) return;
  pi.on('session_start', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify(line, 'info');
  });
  pi.on('before_agent_start', (event) => ({ systemPrompt: \`\${event.systemPrompt}\\n\\n\${line}\` }));
}
`;

/**
 * Install the hook into `agent`'s config and remember exactly what was written. Returns false
 * when a pi extension was left alone because someone wrote or changed it.
 */
export function installHook(ctx: Context, agent: Agent): boolean {
  const file = agent.hooksFile(ctx.io);
  const handler = hookHandler(ctx, agent);
  if (agent.hookKind === 'pi-extension') {
    const written = writeOwned((ctx.config.extensions ??= {}), file, piExtension(handler.command!));
    if (written) ctx.save();
    return written;
  }
  const hooks = (ctx.config.hooks ??= {});
  writeJson(file, withHook(readJson<Json>(file, {}), handler, hooks[file]), { createMode: 0o600 });
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
    const next = withoutHook(settings, handler);
    if (JSON.stringify(next) === JSON.stringify(settings)) continue;
    writeJson(file, next);
    removed.push(file);
  }
  const extensions = removeOwned(ctx.config.extensions ?? {});
  return { removed: [...removed, ...extensions.removed], kept: extensions.kept };
}
