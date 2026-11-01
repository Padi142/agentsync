import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RESERVED_SKILL_NAME, type ScannedSkill } from '@agentsync/contract';
import type { Io } from '../io.js';
import { writeJson } from '../files.js';
import { folderHash, HashTimeout } from './hash.js';
import { recordOf, type ManagedSkill, type Place } from './state.js';

/** An entry of the `skills` CLI's global lock (`.skill-lock.json`, version 3). */
interface LockEntry {
  source?: string;
  sourceType?: string;
  ref?: string;
}

/** What is on disk under one skill name, in both skills directories. */
export interface Folder {
  /** Where anything at all is at `<dir>/<name>`, a folder without a SKILL.md or a dangling link included. */
  present: Place[];
  /** Some copy has a SKILL.md: it's a skill, so the scan reports it. */
  skill: boolean;
  /** The git tree hash of the copies, `null` unless every present copy has a SKILL.md and they are identical. */
  hash: string | null;
  /** The `skills` lock's GitHub source for the name, lowercase, or `null`. */
  lockSource: string | null;
  /** The lock has an entry for the name from something other than GitHub (a local path, GitLab): never AgentSync's. */
  lockOther: boolean;
}

export interface Scan {
  /** What the server is told: never file contents, and hand-written folders by name only. */
  items: ScannedSkill[];
  folders: Map<string, Folder>;
}

export const PLACES: readonly Place[] = ['agents', 'claude'];

/** A skills directory, resolved exactly as `skills` 1.7.4 resolves it (it trims `CLAUDE_CONFIG_DIR`). */
export function skillDir(io: Io, place: Place): string {
  if (place === 'agents') return join(io.home, '.agents', 'skills');
  return join(io.env.CLAUDE_CONFIG_DIR?.trim() || join(io.home, '.claude'), 'skills');
}

/** Where `skills` keeps its global lock: `$XDG_STATE_HOME/skills/` if set, else `~/.agents/`. */
const lockFile = (io: Io) =>
  io.env.XDG_STATE_HOME ? join(io.env.XDG_STATE_HOME, 'skills', '.skill-lock.json') : join(io.home, '.agents', '.skill-lock.json');

async function readLock(io: Io): Promise<Record<string, LockEntry>> {
  try {
    const lock = JSON.parse(await readFile(lockFile(io), 'utf8')) as { skills?: Record<string, LockEntry> };
    return lock.skills && typeof lock.skills === 'object' ? lock.skills : {};
  } catch {
    return {};
  }
}

const listing = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((name) => !name.startsWith('.'));
const exists = (path: string) => lstat(path).then(() => true, () => false);
const hasSkillMd = (dir: string) => stat(join(dir, 'SKILL.md')).then((found) => found.isFile(), () => false);

/** Look at `name` in both directories; hash its copies only if `wantHash` (a hand-written folder's hash is never needed). */
async function inspect(io: Io, name: string, wantHash: boolean, deadline?: number): Promise<Pick<Folder, 'present' | 'skill' | 'hash'>> {
  const present: Place[] = [];
  const withSkill: string[] = [];
  for (const place of PLACES) {
    const path = join(skillDir(io, place), name);
    if (!(await exists(path))) continue;
    present.push(place);
    if (await hasSkillMd(path)) withSkill.push(path);
  }
  if (!wantHash || !withSkill.length || withSkill.length !== present.length) return { present, skill: withSkill.length > 0, hash: null };
  // A symlink (the default `skills` layout) resolves to the canonical copy; separate real copies are hashed each.
  const real = [...new Set(await Promise.all(withSkill.map((path) => realpath(path))))];
  const hashes = new Set<string | null>();
  for (const dir of real) hashes.add(await folderHash(dir, deadline));
  const [hash] = hashes;
  return { present, skill: true, hash: hashes.size === 1 ? (hash ?? null) : null };
}

/** The report takes at most this many skills. */
const MAX_REPORTED = 1000;

/**
 * Scan this Machine's skills in-process: read the `skills` lock, list both skills directories and hash
 * the folders that came from the lock or that AgentSync manages. `names` are looked at even if absent
 * (the Skills this Machine should have); with `only`, nothing else is. A folder without a SKILL.md is
 * not reported (Claude Code keeps its own `synced/` there), and neither is the CLI's own `agentsync`
 * skill. Past `deadline` it throws (`HashTimeout`).
 */
export async function scanSkills(
  io: Io,
  managed: Readonly<Record<string, ManagedSkill>>,
  names: Iterable<string> = [],
  { deadline, only = false }: { deadline?: number; only?: boolean } = {},
): Promise<Scan> {
  const lock = await readLock(io);
  const listed = only ? [] : [...(await Promise.all(PLACES.map((place) => listing(skillDir(io, place))))).flat(), ...Object.keys(managed)];
  const all = new Set([...listed, ...names]);
  all.delete(RESERVED_SKILL_NAME);
  const folders = new Map<string, Folder>();
  const items: ScannedSkill[] = [];
  for (const name of [...all].sort()) {
    if (deadline !== undefined && Date.now() > deadline) throw new HashTimeout();
    const entry = Object.hasOwn(lock, name) ? lock[name] : undefined;
    const source = entry?.sourceType === 'github' && typeof entry.source === 'string' ? entry.source : null;
    const isManaged = recordOf(managed, name) !== undefined;
    const { present, skill, hash } = await inspect(io, name, source !== null || isManaged, deadline);
    folders.set(name, { present, skill, hash, lockSource: source?.toLowerCase() ?? null, lockOther: entry !== undefined && source === null });
    if (!skill || items.length >= MAX_REPORTED) continue;
    items.push({
      name: name.slice(0, 255),
      source: source?.slice(0, 300) ?? null,
      ref: source && typeof entry?.ref === 'string' ? entry.ref.slice(0, 100) : null,
      // A hand-written folder is reported by name only.
      hash: source || isManaged ? hash : null,
      managed: isManaged,
    });
  }
  return { items, folders };
}

/** Drop `name` from the `skills` lock, as `skills remove` would have. */
export async function forgetLockEntry(io: Io, name: string): Promise<void> {
  const file = lockFile(io);
  let lock: { skills?: Record<string, unknown> };
  try {
    lock = JSON.parse(await readFile(file, 'utf8')) as typeof lock;
  } catch {
    return;
  }
  if (!lock.skills || !Object.hasOwn(lock.skills, name)) return;
  delete lock.skills[name];
  writeJson(file, lock);
}
