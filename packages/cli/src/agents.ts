import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Target } from '@agentsync/contract';
import type { Io } from './io.js';
import { expandHome, tildify } from './paths.js';

/** An agent AgentSync knows how to set up: where it reads Global Instructions, skills and hooks. */
export interface Agent {
  id: 'claude' | 'codex' | 'pi' | 'opencode';
  name: string;
  /** The agent's own config directory. It existing is how we detect the agent. */
  home(io: Io): string;
  instructions(io: Io): string;
  skillFile(io: Io): string;
  hooksFile(io: Io): string;
  /**
   * How the hook is installed: `json` adds a SessionStart handler to the JSON hook config in
   * `hooksFile`; `pi-extension` and `opencode-plugin` write `hooksFile` whole.
   */
  hookKind: 'json' | 'pi-extension' | 'opencode-plugin';
  /** The agent's name in the `skills` CLI (`-a`), which installs Skills for it. */
  skillsAgent: 'claude-code' | 'codex' | 'pi' | 'opencode';
  /** The arguments that start the agent in the terminal with `prompt` as its first message. */
  launchArgs(prompt: string): string[];
  /** The agent reads its Global Instructions after the hook ran, so the starting session gets an update. */
  readsAfterHook: boolean;
  /**
   * The hook may print a JSON object: `systemMessage` is shown to the person and
   * `additionalContext` goes to the model. Otherwise its plain stdout goes to the model only.
   */
  hookJson: boolean;
}

export const AGENTS: readonly Agent[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    home: (io) => io.env.CLAUDE_CONFIG_DIR || join(io.home, '.claude'),
    instructions(io) {
      return join(this.home(io), 'CLAUDE.md');
    },
    skillFile(io) {
      return join(this.home(io), 'skills', 'agentsync', 'SKILL.md');
    },
    hooksFile(io) {
      return join(this.home(io), 'settings.json');
    },
    hookKind: 'json',
    skillsAgent: 'claude-code',
    launchArgs: (prompt) => [prompt],
    readsAfterHook: false,
    hookJson: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    home: (io) => io.env.CODEX_HOME || join(io.home, '.codex'),
    instructions(io) {
      return join(this.home(io), 'AGENTS.md');
    },
    // Codex reads user skills from ~/.agents/skills, not from its own home.
    skillFile: (io) => join(io.home, '.agents', 'skills', 'agentsync', 'SKILL.md'),
    hooksFile(io) {
      return join(this.home(io), 'hooks.json');
    },
    hookKind: 'json',
    skillsAgent: 'codex',
    launchArgs: (prompt) => [prompt],
    readsAfterHook: false,
    hookJson: true,
  },
  {
    id: 'pi',
    name: 'pi',
    // pi expands a leading `~` in $PI_CODING_AGENT_DIR itself, the same way expandHome does.
    home: (io) => (io.env.PI_CODING_AGENT_DIR ? expandHome(io.env.PI_CODING_AGENT_DIR, io) : join(io.home, '.pi', 'agent')),
    instructions(io) {
      return join(this.home(io), 'AGENTS.md');
    },
    // pi reads user skills from ~/.agents/skills too, so it shares Codex's copy.
    skillFile: (io) => join(io.home, '.agents', 'skills', 'agentsync', 'SKILL.md'),
    // pi has no hook config. An extension runs the hook, and pi awaits it before reading AGENTS.md.
    hooksFile(io) {
      return join(this.home(io), 'extensions', 'agentsync.ts');
    },
    hookKind: 'pi-extension',
    skillsAgent: 'pi',
    launchArgs: (prompt) => [prompt],
    readsAfterHook: true,
    // The extension shows the line to the person itself.
    hookJson: false,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    // Where OpenCode 1.x and 2.x both look: $OPENCODE_CONFIG_DIR replaces the XDG config directory.
    home: (io) => io.env.OPENCODE_CONFIG_DIR || join(io.env.XDG_CONFIG_HOME || join(io.home, '.config'), 'opencode'),
    instructions(io) {
      return join(this.home(io), 'AGENTS.md');
    },
    // OpenCode reads user skills from ~/.agents/skills too, so it shares Codex's copy.
    skillFile: (io) => join(io.home, '.agents', 'skills', 'agentsync', 'SKILL.md'),
    // OpenCode has no hook config. A plugin runs the hook, and OpenCode awaits it before the first request.
    hooksFile(io) {
      return join(this.home(io), 'plugins', 'agentsync.ts');
    },
    hookKind: 'opencode-plugin',
    skillsAgent: 'opencode',
    // A bare argument is the project directory to open.
    launchArgs: (prompt) => ['--prompt', prompt],
    readsAfterHook: true,
    // The plugin adds the line to the system prompt itself.
    hookJson: false,
  },
];

export const findAgent = (id: string) => AGENTS.find((agent) => agent.id === id);

export const detectAgents = (io: Io) => AGENTS.filter((agent) => existsSync(agent.home(io)));

export const targetFor = (agent: Agent, io: Io): Target => ({
  path: tildify(agent.instructions(io), io),
  agent: agent.id,
});
