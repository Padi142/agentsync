import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Target } from '@agentsync/contract';
import type { Io } from './io.js';
import { expandHome, tildify } from './paths.js';

/** An agent AgentSync knows how to set up: where it reads Global Instructions, skills and hooks. */
export interface Agent {
  id: 'claude' | 'codex' | 'pi';
  name: string;
  /** The agent's own config directory. It existing is how we detect the agent. */
  home(io: Io): string;
  instructions(io: Io): string;
  skillFile(io: Io): string;
  hooksFile(io: Io): string;
  /**
   * How the SessionStart hook is installed: `json` adds a handler to the JSON hook config in
   * `hooksFile`; `pi-extension` writes `hooksFile` whole, as a pi extension.
   */
  hookKind: 'json' | 'pi-extension';
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
    readsAfterHook: true,
    // The extension shows the line to the person itself.
    hookJson: false,
  },
];

export const findAgent = (id: string) => AGENTS.find((agent) => agent.id === id);

export const detectAgents = (io: Io) => AGENTS.filter((agent) => existsSync(agent.home(io)));

export const targetFor = (agent: Agent, io: Io): Target => ({
  path: tildify(agent.instructions(io), io),
  agent: agent.id,
});
