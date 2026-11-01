import { SKILL_COPY_EXCLUDES } from '@agentsync/contract';

/** One entry of GitHub's `git/trees/<sha>?recursive=1` listing. */
export interface GitTreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

/** A folder that `skills` cannot copy byte for byte: it holds a symlink (dereferenced on copy) or a submodule. */
export class UnsupportedSkillFolder extends Error {}

interface Dir {
  files: Map<string, { mode: string; sha: string }>;
  dirs: Map<string, Dir>;
}

const excludedNames = new Set<string>(SKILL_COPY_EXCLUDES.names);
const excludedDirs = new Set<string>(SKILL_COPY_EXCLUDES.dirs);
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

function compareBytes(a: Uint8Array, b: Uint8Array) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Git's tree object for `dir`, hashed; `null` for an empty tree, which git leaves out. */
async function hashDir(dir: Dir): Promise<Uint8Array | null> {
  const entries: { key: Uint8Array; header: Uint8Array; sha: Uint8Array }[] = [];
  for (const [name, file] of dir.files) {
    entries.push({ key: encoder.encode(name), header: encoder.encode(`${file.mode} ${name}\0`), sha: fromHex(file.sha) });
  }
  for (const [name, child] of dir.dirs) {
    const sha = await hashDir(child);
    // Git sorts a directory as if its name ended in "/".
    if (sha) entries.push({ key: encoder.encode(`${name}/`), header: encoder.encode(`40000 ${name}\0`), sha });
  }
  if (!entries.length) return null;
  entries.sort((a, b) => compareBytes(a.key, b.key));
  const body = entries.flatMap((entry) => [entry.header, entry.sha]);
  const length = body.reduce((sum, part) => sum + part.length, 0);
  const object = new Uint8Array(encoder.encode(`tree ${length}\0`).length + length);
  let offset = 0;
  for (const part of [encoder.encode(`tree ${length}\0`), ...body]) {
    object.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-1', object));
}

/**
 * The git tree hash a skill folder has on disk after `skills add`, from GitHub's recursive tree listing
 * alone (no file downloads): the folder without what `skills` leaves out on copy. `folder` is `''` for
 * the repository root. Throws `UnsupportedSkillFolder` for symlinks, submodules and empty folders.
 */
export async function installedFolderHash(tree: GitTreeItem[], folder: string): Promise<string> {
  const root: Dir = { files: new Map(), dirs: new Map() };
  const prefix = folder ? `${folder}/` : '';
  for (const item of tree) {
    if (!item.path.startsWith(prefix) || item.type === 'tree') continue;
    const parts = item.path.slice(prefix.length).split('/');
    const name = parts.pop()!;
    // An excluded directory takes everything in it along, as `skills` never descends into it.
    if (parts.some((part) => excludedDirs.has(part) || excludedNames.has(part))) continue;
    // Left out on copy whatever it is, so it can't make the folder unsupported either.
    if (excludedNames.has(name) || (item.type === 'commit' && excludedDirs.has(name))) continue;
    if (item.mode === '120000') throw new UnsupportedSkillFolder(`${item.path} is a symlink.`);
    if (item.type === 'commit') throw new UnsupportedSkillFolder(`${item.path} is a submodule.`);
    let dir = root;
    for (const part of parts) {
      let child = dir.dirs.get(part);
      if (!child) dir.dirs.set(part, (child = { files: new Map(), dirs: new Map() }));
      dir = child;
    }
    dir.files.set(name, { mode: item.mode, sha: item.sha });
  }
  const sha = await hashDir(root);
  if (!sha) throw new UnsupportedSkillFolder(`${folder || 'The repository'} has no files to install.`);
  return hex(sha);
}
