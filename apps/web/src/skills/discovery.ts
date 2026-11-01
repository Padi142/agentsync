import { parse } from 'yaml';
import type { GitHub } from './github';
import type { GitTreeItem } from './hash';

// Ported from `skills` 1.7.4 (`discoverSkills` in dist/cli.mjs) so the server pins the folder that
// `skills add <repo> --skill <name>` installs. Bump with the `skills` version.

/** Agent skill directories inside a repository, searched like `skills/`. */
const AGENT_PROJECT_SKILL_DIRS = [
  '.agents/skills', '.claude/skills', '.cline/skills', '.codebuddy/skills', '.codex/skills', '.commandcode/skills',
  '.continue/skills', '.factory/skills', '.github/skills', '.goose/skills', '.grok/skills', '.iflow/skills',
  '.junie/skills', '.kilo/skills', '.kilocode/skills', '.kimchi/skills', '.kiro/skills', '.minimax/skills',
  '.mux/skills', '.neovate/skills', '.opencode/skills', '.openhands/skills', '.pi/skills', '.posit/assistant/skills',
  '.qoder/skills', '.roo/skills', '.trae/skills', '.windsurf/skills', '.zcode/skills', '.zencoder/skills',
];
const CONTAINERS = ['skills', 'skills/.curated', 'skills/.experimental', 'skills/.system', ...AGENT_PROJECT_SKILL_DIRS];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__']);
/** Reading SKILL.md files costs a request each (a Worker request may make only 50), so stop after this many. */
const MAX_READS = 30;

const join = (...parts: string[]) => parts.filter(Boolean).join('/');
const parent = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** `./a/../b` → `b`, or `null` if it climbs out of the repository or isn't `./`-relative. */
function relativePath(from: string, path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('./')) return null;
  const parts: string[] = from ? from.split('/') : [];
  for (const part of path.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** The extra directories `.claude-plugin/marketplace.json` and `plugin.json` declare, searched one level deep. */
async function pluginDirs(read: (path: string) => Promise<string | null>, has: (path: string) => boolean): Promise<string[]> {
  const dirs: string[] = [];
  const add = (pluginBase: string | null, skills: unknown) => {
    if (pluginBase === null) return;
    if (Array.isArray(skills)) {
      for (const skill of skills) {
        const path = relativePath(pluginBase, skill);
        if (path !== null) dirs.push(parent(path));
      }
    }
    dirs.push(join(pluginBase, 'skills'));
  };
  const json = async (path: string) => {
    if (!has(path)) return null;
    try {
      return JSON.parse((await read(path)) ?? '') as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const marketplace = await json('.claude-plugin/marketplace.json');
  const root = (marketplace?.metadata as { pluginRoot?: unknown } | undefined)?.pluginRoot;
  if (marketplace && (root === undefined || typeof root === 'string')) {
    const pluginRoot = root === undefined ? '' : relativePath('', root);
    for (const plugin of Array.isArray(marketplace.plugins) ? marketplace.plugins : []) {
      const source = (plugin as { source?: unknown }).source;
      if (source !== undefined && typeof source !== 'string') continue;
      if (pluginRoot === null) continue;
      add(source === undefined ? pluginRoot : relativePath(pluginRoot, source), (plugin as { skills?: unknown }).skills);
    }
  }
  const manifest = await json('.claude-plugin/plugin.json');
  if (manifest) add('', manifest.skills);
  return dirs;
}

/**
 * The folders `skills` would consider, in the order it walks them: a root `SKILL.md` alone; else the
 * children of the root, the containers (three levels deep) and plugin directories, where a folder with a
 * `SKILL.md` shadows anything inside it; else every folder with a `SKILL.md` up to five levels deep.
 */
export async function skillFolders(tree: GitTreeItem[], read: (path: string) => Promise<string | null>): Promise<string[]> {
  const paths = new Set(tree.map((item) => item.path));
  const withSkill = new Set(tree.filter((item) => item.type === 'blob' && base(item.path) === 'SKILL.md').map((item) => parent(item.path)));
  if (paths.has('SKILL.md')) return [''];
  const children = new Map<string, string[]>();
  for (const item of tree) {
    if (item.type !== 'tree') continue;
    const list = children.get(parent(item.path)) ?? [];
    list.push(item.path);
    children.set(parent(item.path), list);
  }
  for (const list of children.values()) list.sort();

  const found: string[] = [];
  const walk = (dir: string, maxDepth: number, depth = 1) => {
    for (const child of children.get(dir) ?? []) {
      if (withSkill.has(child)) {
        if (!found.includes(child)) found.push(child);
        continue;
      }
      if (depth < maxDepth && !SKIP_DIRS.has(base(child))) walk(child, maxDepth, depth + 1);
    }
  };
  walk('', 1);
  for (const container of CONTAINERS) walk(container, 3);
  for (const dir of await pluginDirs(read, (path) => paths.has(path))) walk(dir, 1);
  if (found.length) return found;
  return [...withSkill]
    .filter((dir) => dir.split('/').length <= 5 && !dir.split('/').some((part) => SKIP_DIRS.has(part)))
    .sort();
}

/** The frontmatter `name` of a SKILL.md, as `skills` reads it, or `null`. */
export function frontmatterName(text: string): string | null {
  const match = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  try {
    const data = parse(match[1]!) as { name?: unknown; description?: unknown } | null;
    if (typeof data?.name !== 'string' || typeof data.description !== 'string' || !data.description) return null;
    return data.name.replace(/[\r\n]+/g, ' ').trim();
  } catch {
    return null;
  }
}

/**
 * The folder of the skill named `name` in the repository at `commit`, or `null`: the first folder in
 * `skills`' own walk order whose SKILL.md declares exactly that name, since `skills` keeps the first
 * skill of a name and drops later ones.
 */
export async function findSkillFolder(gh: GitHub, fullName: string, commit: string, tree: GitTreeItem[], name: string) {
  const read = (path: string) => gh.raw(fullName, commit, path);
  for (const folder of (await skillFolders(tree, read)).slice(0, MAX_READS)) {
    const text = await read(join(folder, 'SKILL.md'));
    // Exact: `skills` names the installed folder after the frontmatter as written.
    if (text !== null && frontmatterName(text) === name) return folder;
  }
  return null;
}
