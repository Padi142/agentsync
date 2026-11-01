import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RESERVED_SKILL_NAME, type ScannedSkill } from '@agentsync/contract';
import { findAgent } from '../agents.js';
import type { ManagedSkill } from '../config.js';
import type { Io } from '../io.js';
import { folderHash } from './hash.js';

/** An entry of the `skills` CLI's global lock (`~/.agents/.skill-lock.json`, version 3). */
interface LockEntry {
  source?: string;
  sourceType?: string;
  ref?: string;
}

/** What is on disk under one skill name, in either skills directory. */
export interface Folder {
  /** Anything at all is at `~/.agents/skills/<name>` or the Claude Code `skills/<name>`, even without a SKILL.md. */
  exists: boolean;
  /** The git tree hash of the folder (`null` if it has no SKILL.md, or its copies differ). */
  hash: string | null;
  /** The `skills` lock has a GitHub entry for it. */
  fromLock: boolean;
}

export interface Scan {
  /** What the server is told: never file contents, and hand-written folders by name only. */
  items: ScannedSkill[];
  folders: Map<string, Folder>;
}

/** The two global skills directories: `~/.agents/skills` (Codex, pi and the canonical copy) and Claude Code's. */
export const skillDirs = (io: Io) => [join(io.home, '.agents', 'skills'), join(findAgent('claude')!.home(io), 'skills')];

/** Where `skills` keeps its global lock: `$XDG_STATE_HOME/skills/` if set, else `~/.agents/`. */
const lockFile = (io: Io) =>
  io.env.XDG_STATE_HOME ? join(io.env.XDG_STATE_HOME, 'skills', '.skill-lock.json') : join(io.home, '.agents', '.skill-lock.json');

async function readLock(io: Io): Promise<Record<string, LockEntry>> {
  try {
    const lock = JSON.parse(await readFile(lockFile(io), 'utf8')) as { skills?: Record<string, LockEntry> };
    return lock.skills ?? {};
  } catch {
    return {};
  }
}

const listing = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((name) => !name.startsWith('.'));
const exists = (path: string) => lstat(path).then(() => true, () => false);
const hasSkillMd = (dir: string) => stat(join(dir, 'SKILL.md')).then((found) => found.isFile(), () => false);

/** The folders under `name`: whether anything is there, and the hash of the real folder(s) behind it. */
async function inspect(io: Io, name: string): Promise<{ exists: boolean; skill: boolean; hash: string | null }> {
  const places = skillDirs(io).map((dir) => join(dir, name));
  const present = (await Promise.all(places.map(async (place) => ((await exists(place)) ? place : null)))).filter((place) => place !== null);
  if (!present.length) return { exists: false, skill: false, hash: null };
  const withSkill = (await Promise.all(present.map(async (place) => ((await hasSkillMd(place)) ? place : null)))).filter((place) => place !== null);
  if (withSkill.length !== present.length) return { exists: true, skill: withSkill.length > 0, hash: null };
  // A symlink (the default `skills` layout) resolves to the canonical copy; separate real copies are hashed each.
  const real = [...new Set(await Promise.all(withSkill.map((place) => realpath(place))))];
  const hashes = new Set(await Promise.all(real.map((dir) => folderHash(dir))));
  const [hash] = hashes;
  return { exists: true, skill: true, hash: hashes.size === 1 ? (hash ?? null) : null };
}

/**
 * Scan this Machine's skills in-process: read the `skills` lock, list both skills directories and hash
 * the folders. `names` are looked at even if absent (the Skills this Machine should have). A folder
 * without a SKILL.md is not a skill (Claude Code keeps its own `synced/` there) and is not reported,
 * and the CLI's own `agentsync` skill is left out.
 */
export async function scanSkills(io: Io, managed: Record<string, ManagedSkill>, names: Iterable<string> = []): Promise<Scan> {
  const lock = await readLock(io);
  const all = new Set([...(await Promise.all(skillDirs(io).map(listing))).flat(), ...Object.keys(managed), ...names]);
  all.delete(RESERVED_SKILL_NAME);
  const folders = new Map<string, Folder>();
  const items: ScannedSkill[] = [];
  for (const name of [...all].sort()) {
    const entry = lock[name];
    const github = entry?.sourceType === 'github' && typeof entry.source === 'string';
    const { exists, skill, hash } = await inspect(io, name);
    folders.set(name, { exists, hash, fromLock: github });
    if (!skill) continue;
    const isManaged = name in managed;
    items.push({
      name: name.slice(0, 255),
      source: github ? entry.source!.slice(0, 300) : null,
      ref: github && typeof entry.ref === 'string' ? entry.ref.slice(0, 100) : null,
      // A hand-written folder is reported by name only.
      hash: github || isManaged ? hash : null,
      managed: isManaged,
    });
  }
  return { items, folders };
}
