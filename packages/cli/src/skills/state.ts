import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, EXIT } from '../exit.js';
import { readJson, removeFile, writeJson } from '../files.js';
import type { Io } from '../io.js';
import { configDir } from '../paths.js';

/**
 * One of the two global skills directories: `agents` is `~/.agents/skills` (Codex, pi, and the
 * canonical copy), `claude` is Claude Code's `skills/`.
 */
export type Place = 'agents' | 'claude';

/** A Skill AgentSync installed or adopted, at the Pin it installed, and exactly which folders are its. */
export interface ManagedSkill {
  repo: string;
  commit: string;
  installedHash: string;
  /** The lock sources (lowercase `owner/repo`) its copies may carry; any other source is someone else's install. */
  sources: string[];
  /** The directories whose `<name>` folder AgentSync wrote or adopted. A folder anywhere else is never touched. */
  places: Place[];
  /** A `skills add` of this Pin failed partway: the copies are AgentSync's but mixed, so the next sync retries. */
  incomplete?: true;
}

/**
 * AgentSync's Skills record on this Machine, in its own file beside the config so that the hook (which
 * writes only `report`) and `skills sync` (which writes only `managed`) never overwrite each other's part.
 */
export interface SkillsState {
  managed: Record<string, ManagedSkill>;
  /** The last scan the hook sent: its hash, and when (ms since the epoch). */
  report?: { hash: string; at: number };
}

const stateFile = (io: Io) => join(configDir(io), 'skills.json');

export function readSkillsState(io: Io): SkillsState {
  const state = readJson<Partial<SkillsState>>(stateFile(io), {});
  return { managed: state.managed ?? {}, ...(state.report ? { report: state.report } : {}) };
}

/** Change the record on disk: read it fresh, apply `change`, write it back, so a concurrent writer's other part survives. */
export function updateSkillsState(io: Io, change: (state: SkillsState) => void): void {
  const state = readSkillsState(io);
  change(state);
  writeJson(stateFile(io), state, { mode: 0o600, dirMode: 0o700 });
}

export function deleteSkillsState(io: Io): void {
  removeFile(stateFile(io));
}

/** AgentSync's record of `name`, never one inherited from `Object.prototype` (a skill may be called `constructor`). */
export const recordOf = (managed: Readonly<Record<string, ManagedSkill>>, name: string): ManagedSkill | undefined =>
  Object.hasOwn(managed, name) ? managed[name] : undefined;

/** A lock older than this, from a process that can't be checked, no longer counts. */
const STALE_LOCK_MS = 30 * 60 * 1000;

/** Whether the process that wrote `file` (its PID inside) is still running. */
function lockHeld(file: string): boolean {
  let pid: number;
  let age: number;
  try {
    pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
    age = Date.now() - statSync(file).mtimeMs;
  } catch {
    return false; // It went away meanwhile.
  }
  if (!Number.isInteger(pid) || pid <= 0) return age < STALE_LOCK_MS;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Run `work` holding the Skills lock (a file with this process's PID), so two `skills sync` (or `init`)
 * runs never plan against each other's half-finished changes. A lock left by a process that no longer
 * runs is taken over.
 */
export async function withSkillsLock<T>(io: Io, work: () => Promise<T>): Promise<T> {
  const dir = configDir(io);
  const file = join(dir, 'skills.lock');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const take = () => {
    const fd = openSync(file, 'wx', 0o600);
    writeSync(fd, String(process.pid));
    return fd;
  };
  let fd: number;
  try {
    fd = take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (lockHeld(file)) throw new CliError('Another `agentsync skills sync` is running on this Machine. Try again when it has finished.', EXIT.error);
    removeFile(file);
    fd = take(); // Two runs racing for a dead lock: only one creates the new file.
  }
  try {
    return await work();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
}
