import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SKILL_COPY_EXCLUDES } from '@agentsync/contract';

const excludedNames = new Set<string>(SKILL_COPY_EXCLUDES.names);
const excludedDirs = new Set<string>(SKILL_COPY_EXCLUDES.dirs);

interface Entry {
  mode: '100644' | '100755' | '120000' | '40000';
  name: string;
  sha: Buffer;
}

const gitObject = (type: 'blob' | 'tree', body: Buffer) => createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest();
/** Git sorts tree entries by name bytes, comparing a directory as if its name ended in "/". */
const sortKey = (entry: Entry) => Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name);

/** Hashing ran past its deadline (the hook's). */
export class HashTimeout extends Error {}

async function treeHash(dir: string, deadline?: number): Promise<Buffer | null> {
  const entries: Entry[] = [];
  for (const name of await readdir(dir)) {
    if (deadline !== undefined && Date.now() > deadline) throw new HashTimeout();
    // `skills` leaves these out whatever they are, so they never count as a change.
    if (excludedNames.has(name)) continue;
    const path = join(dir, name);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      if (excludedDirs.has(name)) continue;
      const sha = await treeHash(path, deadline);
      if (sha) entries.push({ mode: '40000', name, sha }); // git has no empty trees
    } else if (stat.isSymbolicLink()) {
      entries.push({ mode: '120000', name, sha: gitObject('blob', Buffer.from(await readlink(path))) });
    } else if (stat.isFile()) {
      entries.push({ mode: stat.mode & 0o100 ? '100755' : '100644', name, sha: gitObject('blob', await readFile(path)) });
    }
  }
  if (!entries.length) return null;
  entries.sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  return gitObject('tree', Buffer.concat(entries.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`), entry.sha])));
}

/**
 * The git tree hash of a skill folder on disk, leaving out what `skills` never copies
 * (`SKILL_COPY_EXCLUDES`): the server computes the same from GitHub, so a folder that still holds
 * its Pin hashes to the Pin's `installedHash`. `null` for an empty folder. Past `deadline` it throws `HashTimeout`.
 */
export async function folderHash(dir: string, deadline?: number): Promise<string | null> {
  return (await treeHash(dir, deadline))?.toString('hex') ?? null;
}
