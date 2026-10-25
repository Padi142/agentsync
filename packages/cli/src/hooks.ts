import type { Agent } from './agents.js';
import type { Context } from './context.js';
import { readJson, writeJson } from './files.js';

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

/** Install the hook into `agent`'s config file and remember exactly what was written. */
export function installHook(ctx: Context, agent: Agent): void {
  const file = agent.hooksFile(ctx.io);
  const handler = hookHandler(ctx, agent);
  const hooks = (ctx.config.hooks ??= {});
  writeJson(file, withHook(readJson<Json>(file, {}), handler, hooks[file]), { createMode: 0o600 });
  hooks[file] = handler;
  ctx.save();
}

/** Remove every hook AgentSync recorded installing. Returns the files it changed. */
export function uninstallHooks(ctx: Context): string[] {
  const changed: string[] = [];
  for (const [file, handler] of Object.entries(ctx.config.hooks ?? {})) {
    const settings = readJson<Json | null>(file, null);
    if (!settings) continue;
    const next = withoutHook(settings, handler);
    if (JSON.stringify(next) === JSON.stringify(settings)) continue;
    writeJson(file, next);
    changed.push(file);
  }
  return changed;
}
