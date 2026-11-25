import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RESERVED_SKILL_NAMES, type ScannedSkill } from '@agentsync/contract';
import { detectClaudeHomes } from '../agents.js';
import type { Io } from '../io.js';
import { writeJson } from '../files.js';
import { folderHash, HashTimeout } from './hash.js';
import { canonicalSkillsDir, claudePlace, ownedDirs, persistedDirPlaces, recordOf, skillDir, type ManagedSkill, type Place } from './state.js';

export { skillDir };

/** An entry of the `skills` CLI's global lock (`.skill-lock.json`, version 3). */
interface LockEntry {
  source?: string;
  sourceType?: string;
  ref?: string;
}

/** What is on disk under one skill name, across all scanned skills directories. */
export interface Folder {
  /** Where anything at all is at `<dir>/<name>`, a folder without a SKILL.md or a dangling link included. */
  present: Place[];
  /** Some copy has a SKILL.md: it's a skill, so the scan reports it. */
  skill: boolean;
  /** The git tree hash of the copies, `null` unless every present copy has a SKILL.md and they are identical. */
  hash: string | null;
  /** Each present copy's git tree hash (when hashed), so partial updates can distinguish old Pins from hand edits. */
  placeHashes?: ReadonlyMap<Place, string | null>;
  /** The `skills` lock's GitHub source for the name, lowercase, or `null`. */
  lockSource: string | null;
  /** The lock has an entry for the name from something other than GitHub (a local path, GitLab): never AgentSync's. */
  lockOther: boolean;
}

export interface Scan {
  /** What the server is told: never file contents, and hand-written folders by name only. */
  items: ScannedSkill[];
  folders: Map<string, Folder>;
  /** Exact Place keys scanned in this pass, so callers never have to recompute them later. */
  places: Place[];
}

/** Every skills directory to scan: shared `~/.agents/skills`, Antigravity, and every known or detected Claude Code instance. */
export function scanPlaces(
  io: Io,
  managed: Readonly<Record<string, ManagedSkill>>,
  extraPlaces: readonly Place[] = [],
): Place[] {
  const candidates: Place[] = [
    'agents',
    'claude',
    'antigravity',
    ...extraPlaces,
    ...Object.values(managed).flatMap((record) => record.places),
    ...detectClaudeHomes(io).map((dir) => claudePlace(dir, io)),
    ...Object.values(managed).flatMap((record) => persistedDirPlaces(record, io)),
  ];
  const seen = new Set<string>();
  const unique: Place[] = [];
  for (const place of candidates) {
    const key = canonicalSkillsDir(skillDir(io, place));
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(place);
  }
  return unique;
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

/** Whether `path` exists (`'yes'`), is confirmed absent (`'no'`), or cannot be stat'd due to permission/I/O error (`'inaccessible'`). */
async function entryState(path: string): Promise<'yes' | 'no' | 'inaccessible'> {
  try {
    await lstat(path);
    return 'yes';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'no' : 'inaccessible';
  }
}

/** Whether `<dir>/SKILL.md` is a file, genuinely absent (`ENOENT`/`ENOTDIR`), or present/unreadable (e.g. `EACCES`, dangling link). */
async function skillMdState(dir: string): Promise<'file' | 'absent' | 'unreadable'> {
  const file = join(dir, 'SKILL.md');
  try {
    return (await stat(file)).isFile() ? 'file' : 'unreadable';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return lstat(file).then(() => 'unreadable' as const, () => 'absent' as const);
    }
    return 'unreadable';
  }
}

/** Look at `name` in all `places`; hash its copies only if `wantHash` (a hand-written folder's hash is never needed). */
async function inspect(
  io: Io,
  places: readonly Place[],
  name: string,
  wantHash: boolean,
  record?: ManagedSkill,
  deadline?: number,
): Promise<Pick<Folder, 'present' | 'skill' | 'hash' | 'placeHashes'>> {
  const present: Place[] = [];
  const withSkill: { place: Place; path: string }[] = [];
  const unreadable: Place[] = [];
  const owned = record ? ownedDirs(record, io) : undefined;
  for (const place of places) {
    const path = join(skillDir(io, place), name);
    const found = await entryState(path);
    if (found === 'no') continue;
    if (found === 'inaccessible') {
      if (!owned?.has(canonicalSkillsDir(skillDir(io, place)))) continue;
      present.push(place);
      unreadable.push(place);
      continue;
    }
    present.push(place);
    const state = await skillMdState(path);
    if (state === 'file') withSkill.push({ place, path });
    else if (state === 'unreadable') unreadable.push(place);
  }
  if (!wantHash || (!withSkill.length && !unreadable.length)) {
    return { present, skill: withSkill.length > 0, hash: null };
  }
  const allHaveSkillMd = withSkill.length === present.length;
  // A symlink (the default `skills` layout) resolves to the canonical copy; separate real copies are hashed once each.
  // When some present copy is already missing SKILL.md (so aggregate hash is null anyway), tolerate read errors on
  // another copy so `--overwrite` can still repair it, while still hashing readable copies for partial-cleanup retries.
  const realByPlace = await Promise.all(withSkill.map(async ({ place, path }) => [place, await realpath(path)] as const));
  const hashByReal = new Map<string, string | null>();
  for (const [, dir] of realByPlace) {
    if (hashByReal.has(dir)) continue;
    try {
      hashByReal.set(dir, await folderHash(dir, deadline));
    } catch (error) {
      if (error instanceof HashTimeout || allHaveSkillMd) throw error;
      hashByReal.set(dir, null);
    }
  }
  const placeHashes = new Map<Place, string | null>(realByPlace.map(([place, dir]) => [place, hashByReal.get(dir) ?? null]));
  for (const place of unreadable) placeHashes.set(place, null);
  if (!allHaveSkillMd) return { present, skill: withSkill.length > 0, hash: null, placeHashes };
  const hashes = new Set(placeHashes.values());
  const [hash] = hashes;
  return { present, skill: true, hash: hashes.size === 1 ? (hash ?? null) : null, placeHashes };
}

/** The report takes at most this many skills. */
const MAX_REPORTED = 1000;

/**
 * Scan this Machine's skills in-process: read the `skills` lock, list all skills directories and hash
 * the folders that came from the lock or that AgentSync manages. `names` are looked at even if absent
 * (the Skills this Machine should have); with `only`, nothing else is. A folder without a SKILL.md is
 * not reported (Claude Code keeps its own `synced/` there), and neither are the CLI's own
 * `agentsync*` skills. Past `deadline` it throws (`HashTimeout`).
 */
export async function scanSkills(
  io: Io,
  managed: Readonly<Record<string, ManagedSkill>>,
  names: Iterable<string> = [],
  { deadline, only = false, places: extraPlaces = [] }: { deadline?: number; only?: boolean; places?: readonly Place[] } = {},
): Promise<Scan> {
  const places = scanPlaces(io, managed, extraPlaces);
  const lock = await readLock(io);
  const listed = only ? [] : [...(await Promise.all(places.map((place) => listing(skillDir(io, place))))).flat(), ...Object.keys(managed)];
  const all = new Set([...listed, ...names]);
  for (const name of RESERVED_SKILL_NAMES) all.delete(name);
  const folders = new Map<string, Folder>();
  const items: ScannedSkill[] = [];
  for (const name of [...all].sort()) {
    if (deadline !== undefined && Date.now() > deadline) throw new HashTimeout();
    const entry = Object.hasOwn(lock, name) ? lock[name] : undefined;
    const source = entry?.sourceType === 'github' && typeof entry.source === 'string' ? entry.source : null;
    const record = recordOf(managed, name);
    const isManaged = record !== undefined;
    const { present, skill, hash, placeHashes } = await inspect(io, places, name, source !== null || isManaged, record, deadline);
    folders.set(name, {
      present,
      skill,
      hash,
      ...(placeHashes ? { placeHashes } : {}),
      lockSource: source?.toLowerCase() ?? null,
      lockOther: entry !== undefined && source === null,
    });
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
  return { items, folders, places };
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
