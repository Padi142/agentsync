import { closeSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError, EXIT } from '../exit.js';
import { readJson, removeFile, writeJson } from '../files.js';
import type { Io } from '../io.js';
import { configDir, expandHome, tildify } from '../paths.js';

/**
 * A global skills directory:
 * - `agents`: `~/.agents/skills` (Codex, pi, OpenCode, and the canonical copy)
 * - `claude`: `~/.claude/skills` (the default Claude Code instance)
 * - `claude:<dir>`: `<dir>/skills` (an additional or custom Claude Code instance, e.g. `claude:~/.claude_personal`)
 * - `antigravity`: `~/.gemini/config/skills` (Antigravity App, CLI and IDE)
 * - `dir:<path>`: a persisted canonical skills directory scanned when all aliases pointing to it are gone
 */
export type Place = 'agents' | 'claude' | 'antigravity' | `claude:${string}` | `dir:${string}`;

export const isClaudePlace = (place: Place): boolean => place === 'claude' || place.startsWith('claude:');

/** Resolve `path` through symlinks, following a symlink even when its target does not exist yet. */
function canonicalPath(path: string, depth = 0): string {
  try {
    return realpathSync(path);
  } catch {
    if (depth < 8) {
      try {
        return canonicalPath(resolve(dirname(path), readlinkSync(path)), depth + 1);
      } catch {
        // Not a symlink (or unreadable): resolve the deepest existing ancestor below.
      }
    }
    const parent = dirname(path);
    if (parent === path) return resolve(path);
    return join(canonicalPath(parent, depth + 1), basename(path));
  }
}

/** Canonical path of a Place's skills directory, used to deduplicate aliases consistently across scan and plan. */
export const canonicalSkillsDir = (dir: string): string => canonicalPath(dir);

/** Whether `dir` resolves through a symlink relative to `io.home` (tolerating OS-level symlinks above `io.home`, e.g. `/var` -> `/private/var`). */
export function isSymlinkedSkillsDir(dir: string, io: Io): boolean {
  const resolvedHome = resolve(io.home);
  const canonicalHome = canonicalSkillsDir(resolvedHome);
  const resolvedDir = resolve(dir);
  const expected =
    resolvedDir === resolvedHome || resolvedDir.startsWith(`${resolvedHome}/`) || resolvedDir.startsWith(`${resolvedHome}\\`)
      ? join(canonicalHome, resolvedDir.slice(resolvedHome.length))
      : resolvedDir;
  return canonicalSkillsDir(dir) !== expected;
}

/** Persisted canonical directory Places for `record`, so orphaned copies stay visible even if all aliases were deleted. */
export function persistedDirPlaces(record: ManagedSkill, io: Io): Place[] {
  if (!record.placeDirs) return [];
  return Object.entries(record.placeDirs)
    .filter(([owned]) => !(owned === 'claude' && record.legacyClaude))
    .map(([, dir]): Place => `dir:${tildify(dir, io)}`);
}

/** Canonical skills directories owned by `record` (persisted `placeDirs` when present, else non-symlinked `places`). */
export function ownedDirs(record: ManagedSkill, io: Io): Set<string> {
  if (record.placeDirs) {
    return new Set(
      Object.entries(record.placeDirs)
        .filter(([owned]) => !(owned === 'claude' && record.legacyClaude))
        .map(([, dir]) => dir),
    );
  }
  return new Set(
    record.places
      .filter((place) => !(place === 'claude' && record.legacyClaude) && !isSymlinkedSkillsDir(skillDir(io, place), io))
      .map((place) => canonicalSkillsDir(skillDir(io, place))),
  );
}

/** A skills directory for `place`, matching `skills` 1.9.0's layout. */
export function skillDir(io: Io, place: Place): string {
  if (place === 'agents') return join(io.home, '.agents', 'skills');
  if (place === 'antigravity') return join(io.home, '.gemini', 'config', 'skills');
  if (place.startsWith('dir:')) return expandHome(place.slice('dir:'.length), io);
  if (isClaudePlace(place)) return join(claudeHomeForPlace(place, io), 'skills');
  return join(io.home, '.agents', 'skills');
}

/**
 * The canonical Place key for `place`, following symlinks on its `skills/` directory so planning and
 * scanning agree on one key whenever two agents share a directory (`agents` > `claude` > `antigravity`).
 */
export function canonicalPlace(place: Place, io: Io): Place {
  const dir = canonicalSkillsDir(skillDir(io, place));
  if (dir === canonicalSkillsDir(join(io.home, '.agents', 'skills'))) return 'agents';
  if (dir === canonicalSkillsDir(join(io.home, '.claude', 'skills'))) return 'claude';
  if (dir === canonicalSkillsDir(join(io.home, '.gemini', 'config', 'skills'))) return 'antigravity';
  if (isClaudePlace(place) && basename(dir) === 'skills') return `claude:${tildify(dirname(dir), io)}`;
  return place;
}

/**
 * The Place key for a Claude Code config directory: `'agents'`, `'claude'`, or `'antigravity'` when its
 * `skills/` directory resolves to one of those built-in directories, else `'claude:<canonical>'`.
 */
export function claudePlace(homeDir: string, io: Io): Place {
  const dir = canonicalSkillsDir(join(homeDir, 'skills'));
  if (dir === canonicalSkillsDir(join(io.home, '.agents', 'skills'))) return 'agents';
  if (dir === canonicalSkillsDir(join(io.home, '.claude', 'skills'))) return 'claude';
  if (dir === canonicalSkillsDir(join(io.home, '.gemini', 'config', 'skills'))) return 'antigravity';
  if (basename(dir) === 'skills') return `claude:${tildify(dirname(dir), io)}`;
  return `claude:${tildify(canonicalPath(homeDir), io)}`;
}

/** The Claude Code config directory a Claude Place refers to. */
export function claudeHomeForPlace(place: Place, io: Io): string {
  if (place === 'claude') return join(io.home, '.claude');
  return expandHome(place.slice('claude:'.length), io);
}

/** A Skill AgentSync installed or adopted, at the Pin it installed, and exactly which folders are its. */
export interface ManagedSkill {
  repo: string;
  commit: string;
  installedHash: string;
  /** The lock sources (lowercase `owner/repo`) its copies may carry; any other source is someone else's install. */
  sources: string[];
  /** The directories whose `<name>` folder AgentSync wrote or adopted. A folder anywhere else is never touched. */
  places: Place[];
  /** Canonical skills directory recorded for each owned Place when ownership was established (prevents symlink repointing). */
  placeDirs?: Record<string, string>;
  /** A `skills add` of this Pin failed partway: the copies are AgentSync's but mixed, so the next sync retries. */
  incomplete?: true;
  /** Pin hashes from before interrupted updates, so untouched copies at earlier Pins aren't mistaken for hand edits. */
  previousHashes?: string[];
  /** Canonical dirs of verified orphans whose removal failed partway, so a missing SKILL.md there stays retryable. */
  orphanDirs?: string[];
  /** Legacy pre-v2 `'claude'` entry not yet verified at `~/.claude` or migrated (`'ambiguous'` saw another matching Claude home). */
  legacyClaude?: true | 'ambiguous';
}

/**
 * AgentSync's Skills record on this Machine, in its own file beside the config so that the hook (which
 * writes only `report`) and `skills sync` (which writes only `managed`) never overwrite each other's part.
 */
export interface SkillsState {
  /** Schema version: `2` records custom Claude Code instances explicitly as `claude:<dir>`. Omitted in legacy files. */
  version?: number;
  managed: Record<string, ManagedSkill>;
  /** Last-known required Places from the Machine's registered Targets, so hooks scan custom homes on the first pass. */
  places?: Place[];
  /** The last scan the hook sent: its hash, and when (ms since the epoch). */
  report?: { hash: string; at: number };
}

export const SKILLS_STATE_VERSION = 2;

const stateFile = (io: Io) => join(configDir(io), 'skills.json');

export function readSkillsState(io: Io): SkillsState {
  const state = readJson<Partial<SkillsState>>(stateFile(io), {});
  return {
    ...(state.version === undefined ? {} : { version: state.version }),
    managed: state.managed ?? {},
    ...(Array.isArray(state.places) ? { places: state.places } : {}),
    ...(state.report ? { report: state.report } : {}),
  };
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
    // Take the dead lock over under a second lock, so two runs can't both replace it.
    const takeover = `${file}.takeover`;
    let guard: number;
    try {
      guard = openSync(takeover, 'wx', 0o600);
    } catch (raced) {
      if ((raced as NodeJS.ErrnoException).code !== 'EEXIST') throw raced;
      if (!lockHeld(takeover)) removeFile(takeover); // Left by a run that died mid-takeover; the next try proceeds.
      throw new CliError('Another `agentsync skills sync` is running on this Machine. Try again when it has finished.', EXIT.error);
    }
    try {
      writeSync(guard, String(process.pid));
      if (lockHeld(file)) throw new CliError('Another `agentsync skills sync` is running on this Machine. Try again when it has finished.', EXIT.error);
      removeFile(file);
      try {
        fd = take();
      } catch (raced) {
        // A new run started between the two.
        if ((raced as NodeJS.ErrnoException).code !== 'EEXIST') throw raced;
        throw new CliError('Another `agentsync skills sync` is running on this Machine. Try again when it has finished.', EXIT.error);
      }
    } finally {
      closeSync(guard);
      removeFile(takeover);
    }
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
