import { readFileSync } from 'node:fs';
import type { Agent } from './agents.js';
import { readText, removeFile, writeText } from './files.js';
import type { Io } from './io.js';

/** The agent skill shipped in this package, at `skill/SKILL.md`. */
const skillText = () => readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8');

export function installSkill(io: Io, agent: Agent): string {
  const file = agent.skillFile(io);
  writeText(file, skillText());
  return file;
}

/** Remove the skill if it is still the one AgentSync installed. */
export function uninstallSkill(io: Io, agent: Agent): boolean {
  const file = agent.skillFile(io);
  const text = readText(file);
  if (text === null || !text.includes('name: agentsync')) return false;
  removeFile(file);
  return true;
}
