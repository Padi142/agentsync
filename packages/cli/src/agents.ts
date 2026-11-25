import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Target } from '@agentsync/contract';
import type { Io } from './io.js';
import { expandHome, tildify } from './paths.js';

/** An agent AgentSync knows how to set up: where it reads Global Instructions, skills and hooks. */
export interface Agent {
  id: 'claude' | 'codex' | 'pi' | 'opencode' | 'antigravity';
  name: string;
  /** The executable started when handing Drift or a Conflict to this agent. */
  command: string;
  /** The instructions filename inside the agent's config directory, e.g. `CLAUDE.md` or `AGENTS.md`. */
  instructionsFile: string;
  /** The agent's default config directory. */
  home(io: Io): string;
  /** Whether the agent is installed on this Machine. */
  detect(io: Io): boolean;
  instructions(io: Io, homeDir?: string): string;
  /** The directory the agent reads user skills from: each skill is `<dir>/<name>/SKILL.md`. */
  skillsDir(io: Io, homeDir?: string): string;
  hooksFile(io: Io, homeDir?: string): string;
  /**
   * How the hook is installed: `json` adds a SessionStart handler to Claude Code / Codex hook config;
   * `antigravity-json` adds a named `"agentsync"` SessionStart hook to Antigravity's `hooks.json`;
   * `pi-extension` and `opencode-plugin` write `hooksFile` whole.
   */
  hookKind: 'json' | 'antigravity-json' | 'pi-extension' | 'opencode-plugin';
  /** The agent's name in the `skills` CLI (`-a`), which installs Skills for it. */
  skillsAgent: 'claude-code' | 'codex' | 'pi' | 'opencode' | 'antigravity';
  /** The arguments that start the agent in the terminal with `prompt` as its first message. */
  launchArgs(prompt: string): string[];
  /** The agent reads its Global Instructions after the hook ran, so the starting session gets an update. */
  readsAfterHook: boolean;
  /**
   * Format `sync --hook` prints on stdout:
   * - `claude`: Claude Code / Codex SessionStart JSON (`systemMessage` + `hookSpecificOutput.additionalContext`)
   * - `antigravity`: Antigravity SessionStart JSON (`injectSteps` with `systemMessage` + `metadata.user_markdown`, or `{}` when quiet)
   * - `plain`: a single plain-text `AgentSync:` line
   */
  hookOutput: 'plain' | 'claude' | 'antigravity';
}

/** Files or folders that distinguish a Claude Code config directory from an unrelated `~/.claude*` folder. */
const CLAUDE_HOME_MARKERS = [
  'settings.json',
  'CLAUDE.md',
  '.claude.json',
  '.credentials.json',
  'projects',
  'sessions',
  'plugins',
  'skills',
  'history.jsonl',
] as const;

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const looksLikeClaudeHome = (dir: string): boolean =>
  isDirectory(dir) && CLAUDE_HOME_MARKERS.some((marker) => existsSync(join(dir, marker)));

/** Extra Claude Code config directories configured in T3 Code's `settings.json`, if present. */
function t3ClaudeHomes(io: Io): string[] {
  const file = join(io.home, '.t3', 'userdata', 'settings.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      providerInstances?: Record<string, { driver?: unknown; enabled?: unknown; config?: { homePath?: unknown } }>;
    };
    if (!parsed.providerInstances || typeof parsed.providerInstances !== 'object') return [];
    const homes: string[] = [];
    for (const instance of Object.values(parsed.providerInstances)) {
      if (instance?.driver !== 'claudeAgent' || instance.enabled === false) continue;
      if (typeof instance.config?.homePath !== 'string' || !instance.config.homePath.trim()) continue;
      const dir = expandHome(instance.config.homePath.trim(), io);
      if (isDirectory(dir)) homes.push(dir);
    }
    return homes;
  } catch {
    return [];
  }
}

/**
 * Every Claude Code config directory found on this Machine, `~/.claude` first, then `$CLAUDE_CONFIG_DIR`,
 * sibling `~/.claude*` directories that hold Claude Code files (e.g. `~/.claude_personal`), and any
 * Claude Code provider instance configured in T3 Code. Deduplicated by resolved path.
 */
export function detectClaudeHomes(io: Io): string[] {
  const candidates: string[] = [];
  const defaultDir = join(io.home, '.claude');
  if (isDirectory(defaultDir)) candidates.push(defaultDir);

  const fromEnv = io.env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv) {
    const envDir = expandHome(fromEnv, io);
    if (isDirectory(envDir)) candidates.push(envDir);
  }

  try {
    const siblings = readdirSync(io.home)
      .filter((name) => name.startsWith('.claude') && name !== '.claude')
      .sort();
    for (const name of siblings) {
      const dir = join(io.home, name);
      if (looksLikeClaudeHome(dir)) candidates.push(dir);
    }
  } catch {
    // Home directory unreadable; ignore sibling scan.
  }

  candidates.push(...t3ClaudeHomes(io));

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const dir of candidates) {
    const key = canonicalPath(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(dir);
  }
  return unique;
}

export const AGENTS: readonly Agent[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    instructionsFile: 'CLAUDE.md',
    home: (io) => (io.env.CLAUDE_CONFIG_DIR?.trim() ? expandHome(io.env.CLAUDE_CONFIG_DIR.trim(), io) : join(io.home, '.claude')),
    detect: (io) => detectClaudeHomes(io).length > 0,
    instructions(io, homeDir) {
      return join(homeDir ?? this.home(io), this.instructionsFile);
    },
    skillsDir(io, homeDir) {
      return join(homeDir ?? this.home(io), 'skills');
    },
    hooksFile(io, homeDir) {
      return join(homeDir ?? this.home(io), 'settings.json');
    },
    hookKind: 'json',
    skillsAgent: 'claude-code',
    launchArgs: (prompt) => [prompt],
    readsAfterHook: false,
    hookOutput: 'claude',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    instructionsFile: 'AGENTS.md',
    home: (io) => io.env.CODEX_HOME || join(io.home, '.codex'),
    detect(io) {
      return existsSync(this.home(io));
    },
    instructions(io, homeDir) {
      return join(homeDir ?? this.home(io), this.instructionsFile);
    },
    // Codex reads user skills from ~/.agents/skills, not from its own home.
    skillsDir: (io) => join(io.home, '.agents', 'skills'),
    hooksFile(io, homeDir) {
      return join(homeDir ?? this.home(io), 'hooks.json');
    },
    hookKind: 'json',
    skillsAgent: 'codex',
    launchArgs: (prompt) => [prompt],
    readsAfterHook: false,
    hookOutput: 'claude',
  },
  {
    id: 'pi',
    name: 'pi',
    command: 'pi',
    instructionsFile: 'AGENTS.md',
    // pi expands a leading `~` in $PI_CODING_AGENT_DIR itself, the same way expandHome does.
    home: (io) => (io.env.PI_CODING_AGENT_DIR ? expandHome(io.env.PI_CODING_AGENT_DIR, io) : join(io.home, '.pi', 'agent')),
    detect(io) {
      return existsSync(this.home(io));
    },
    instructions(io, homeDir) {
      return join(homeDir ?? this.home(io), this.instructionsFile);
    },
    // pi reads user skills from ~/.agents/skills too, so it shares Codex's copy.
    skillsDir: (io) => join(io.home, '.agents', 'skills'),
    // pi has no hook config. An extension runs the hook, and pi awaits it before reading AGENTS.md.
    hooksFile(io, homeDir) {
      return join(homeDir ?? this.home(io), 'extensions', 'agentsync.ts');
    },
    hookKind: 'pi-extension',
    skillsAgent: 'pi',
    launchArgs: (prompt) => [prompt],
    readsAfterHook: true,
    // The extension shows the line to the person itself.
    hookOutput: 'plain',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    instructionsFile: 'AGENTS.md',
    // Where OpenCode 1.x and 2.x both look: $OPENCODE_CONFIG_DIR replaces the XDG config directory.
    home: (io) => io.env.OPENCODE_CONFIG_DIR || join(io.env.XDG_CONFIG_HOME || join(io.home, '.config'), 'opencode'),
    detect(io) {
      return existsSync(this.home(io));
    },
    instructions(io, homeDir) {
      return join(homeDir ?? this.home(io), this.instructionsFile);
    },
    // OpenCode reads user skills from ~/.agents/skills too, so it shares Codex's copy.
    skillsDir: (io) => join(io.home, '.agents', 'skills'),
    // OpenCode has no hook config. A plugin runs the hook, and OpenCode awaits it before the first request.
    hooksFile(io, homeDir) {
      return join(homeDir ?? this.home(io), 'plugins', 'agentsync.ts');
    },
    hookKind: 'opencode-plugin',
    skillsAgent: 'opencode',
    // A bare argument is the project directory to open.
    launchArgs: (prompt) => ['--prompt', prompt],
    readsAfterHook: true,
    // The plugin adds the line to the system prompt itself.
    hookOutput: 'plain',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    instructionsFile: 'AGENTS.md',
    // Antigravity App, CLI (agy) and IDE all read personal rules, skills and hooks from ~/.gemini/config/.
    home: (io) => join(io.home, '.gemini', 'config'),
    detect: (io) =>
      ['config', 'antigravity', 'antigravity-cli', 'antigravity-ide'].some((sub) =>
        existsSync(join(io.home, '.gemini', sub)),
      ),
    instructions(io, homeDir) {
      return join(homeDir ?? this.home(io), this.instructionsFile);
    },
    // Antigravity reads global skills from ~/.gemini/config/skills, not ~/.agents/skills.
    skillsDir(io, homeDir) {
      return join(homeDir ?? this.home(io), 'skills');
    },
    hooksFile(io, homeDir) {
      return join(homeDir ?? this.home(io), 'hooks.json');
    },
    hookKind: 'antigravity-json',
    skillsAgent: 'antigravity',
    launchArgs: (prompt) => ['--prompt-interactive', prompt],
    readsAfterHook: false,
    hookOutput: 'antigravity',
  },
];

export const findAgent = (id: string) => AGENTS.find((agent) => agent.id === id);

export const detectAgents = (io: Io) => AGENTS.filter((agent) => agent.detect(io));

export const targetFor = (agent: Agent, io: Io, homeDir?: string): Target => ({
  path: tildify(agent.instructions(io, homeDir), io),
  agent: agent.id,
});

/** The config directory for a registered Target of `agent` (inferred from the path only for Claude Code). */
export function targetHome(agent: Agent, target: Target, io: Io): string {
  if (agent.id !== 'claude') return agent.home(io);
  const expanded = expandHome(target.path, io);
  return basename(expanded) === agent.instructionsFile ? dirname(expanded) : agent.home(io);
}

/** Deduplicated `(agent, homeDir)` instances represented by `targets`, in order. */
export function agentInstances(targets: readonly Target[], io: Io): { agent: Agent; homeDir: string }[] {
  const seen = new Set<string>();
  const instances: { agent: Agent; homeDir: string }[] = [];
  for (const target of targets) {
    const agent = findAgent(target.agent);
    if (!agent) continue;
    const homeDir = targetHome(agent, target, io);
    const key = `${agent.id}\0${resolve(homeDir)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    instances.push({ agent, homeDir });
  }
  return instances;
}
