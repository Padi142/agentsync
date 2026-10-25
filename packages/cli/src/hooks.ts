import type { Agent } from './agents.js';
import { readJson, writeJson } from './files.js';
import type { Io } from './io.js';

type Json = Record<string, unknown>;
interface Handler {
  type?: string;
  command?: string;
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

const isOurs = (handler: Handler) =>
  handler.type === 'command' && /agentsync.* sync --hook /.test(handler.command ?? '');

/** SessionStart groups with every AgentSync handler removed, dropping groups left empty. */
function otherGroups(settings: Json): Group[] {
  const hooks = (settings.hooks ?? {}) as Record<string, Group[]>;
  return (hooks.SessionStart ?? []).flatMap((group) => {
    const handlers = group.hooks ?? [];
    const kept = handlers.filter((handler) => !isOurs(handler));
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
 * Add AgentSync's SessionStart hook to an agent's hook config (Claude Code's settings.json and
 * Codex's hooks.json share this shape). Idempotent: an existing AgentSync hook is replaced.
 * Everything else is kept as it was.
 */
export function withHook(settings: Json, command: string): Json {
  const ours: Group = { hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS } as Handler] };
  return withGroups(settings, [...otherGroups(settings), ours]);
}

/** Remove AgentSync's SessionStart hook, keeping everything else. */
export function withoutHook(settings: Json): Json {
  const before = ((settings.hooks ?? {}) as Record<string, Group[]>).SessionStart;
  if (!before) return settings;
  return withGroups(settings, otherGroups(settings));
}

export const hookCommand = (io: Io, agent: Agent) => `${io.self} sync --hook ${agent.id}`;

/** Install the hook into `agent`'s config file. */
export function installHook(io: Io, agent: Agent): void {
  const file = agent.hooksFile(io);
  writeJson(file, withHook(readJson<Json>(file, {}), hookCommand(io, agent)));
}

/** Remove the hook from `agent`'s config file, if it is there. */
export function uninstallHook(io: Io, agent: Agent): boolean {
  const file = agent.hooksFile(io);
  const settings = readJson<Json | null>(file, null);
  if (!settings) return false;
  const next = withoutHook(settings);
  if (JSON.stringify(next) === JSON.stringify(settings)) return false;
  writeJson(file, next);
  return true;
}
