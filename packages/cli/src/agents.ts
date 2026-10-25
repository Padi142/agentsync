import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Target } from '@agentsync/contract';
import type { Io } from './io.js';
import { tildify } from './paths.js';

/** An agent AgentSync knows how to set up: where it reads Global Instructions, skills and hooks. */
export interface Agent {
  id: 'claude' | 'codex';
  name: string;
  /** The agent's own config directory. It existing is how we detect the agent. */
  home(io: Io): string;
  instructions(io: Io): string;
  skillFile(io: Io): string;
  hooksFile(io: Io): string;
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
  },
];

export const findAgent = (id: string) => AGENTS.find((agent) => agent.id === id);

export const detectAgents = (io: Io) => AGENTS.filter((agent) => existsSync(agent.home(io)));

export const targetFor = (agent: Agent, io: Io): Target => ({
  path: tildify(agent.instructions(io), io),
  agent: agent.id,
});
