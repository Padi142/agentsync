import { normalizeSpacePath, SPACE_PUBLIC_ROUTES, type SpaceFile } from '@agentsync/contract';

/**
 * Pure helpers for showing a Space's files: which one opens first, how they nest, how each one
 * renders, and how relative URLs inside a file resolve to the Space's raw routes.
 */

/** How the viewer shows a file. */
export type FileKind = 'markdown' | 'html' | 'image' | 'text' | 'binary';

/** Text bigger than this downloads instead of rendering. */
export const MAX_INLINE_BYTES = 2 * 1024 * 1024;

const extension = (path: string) => path.slice(path.lastIndexOf('/') + 1).split('.').slice(1).pop()?.toLowerCase() ?? '';

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|sql|graphql)\b|[^;]*\+(json|xml)\b)/;
const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml', 'css', 'scss',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql', 'lua', 'diff', 'patch', 'vue', 'svelte',
]);

export function fileKind(file: Pick<SpaceFile, 'path' | 'contentType' | 'size'>): FileKind {
  const ext = extension(file.path);
  const type = file.contentType.toLowerCase();
  const fits = file.size <= MAX_INLINE_BYTES;
  if (ext === 'md' || ext === 'markdown' || type.startsWith('text/markdown')) return fits ? 'markdown' : 'binary';
  if (ext === 'html' || ext === 'htm' || type.startsWith('text/html')) return fits ? 'html' : 'binary';
  if (type.startsWith('image/')) return 'image';
  if (TEXT_TYPES.test(type) || TEXT_EXTENSIONS.has(ext)) return fits ? 'text' : 'binary';
  return 'binary';
}

/** The folder a path is in: `''` at the root. */
export const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/**
 * The file that opens when no file is asked for: `index.html`, else the only root `.html` or `.md`,
 * else `README.md`, else the first one.
 */
export function defaultFile<File extends Pick<SpaceFile, 'path'>>(files: File[]): File | undefined {
  const byPath = (path: string) => files.find((f) => f.path === path);
  const rootPages = files.filter((f) => !f.path.includes('/') && /\.(html?|md)$/i.test(f.path));
  return byPath('index.html')
    ?? (rootPages.length === 1 ? rootPages[0] : undefined)
    ?? files.find((f) => f.path.toLowerCase() === 'readme.md')
    ?? files[0];
}

/** The file to show for the `file` search param, and the asked-for path when it isn't in the Space. */
export function pickFile<File extends Pick<SpaceFile, 'path'>>(files: File[], requested: string | undefined) {
  const found = requested === undefined ? undefined : files.find((f) => f.path === requested);
  return { file: found ?? defaultFile(files), missing: requested !== undefined && !found ? requested : null };
}

export type TreeFolder<File> = { kind: 'folder'; name: string; path: string; children: TreeNode<File>[] };
export type TreeNode<File> = TreeFolder<File> | { kind: 'file'; name: string; path: string; file: File };

/** Files nested by folder: folders first, then files, each by name. */
export function buildTree<File extends Pick<SpaceFile, 'path'>>(files: File[]): TreeNode<File>[] {
  const root: TreeFolder<File> = { kind: 'folder', name: '', path: '', children: [] };
  for (const file of files) {
    const segments = file.path.split('/');
    let folder = root;
    segments.slice(0, -1).forEach((name, i) => {
      const path = segments.slice(0, i + 1).join('/');
      let next = folder.children.find((c): c is TreeFolder<File> => c.kind === 'folder' && c.name === name);
      if (!next) folder.children.push(next = { kind: 'folder', name, path, children: [] });
      folder = next;
    });
    folder.children.push({ kind: 'file', name: segments.at(-1)!, path: file.path, file });
  }
  const sort = (nodes: TreeNode<File>[]): TreeNode<File>[] =>
    nodes
      .map((n) => (n.kind === 'folder' ? { ...n, children: sort(n.children) } : n))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
  return sort(root.children);
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * The Space path a URL inside the file at `dir` points to, with its `#hash`, or `null` for URLs that
 * leave the Space: other schemes, `//host`, plain `#anchors`, or `..` above the root. A leading `/`
 * means the Space's root.
 */
export function resolveSpacePath(url: string, dir: string): { path: string; hash: string } | null {
  if (!url || SCHEME.test(url) || url.startsWith('//') || url.startsWith('#')) return null;
  const hashAt = url.indexOf('#');
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const bare = url.slice(0, hashAt < 0 ? undefined : hashAt).split('?')[0]!;
  const segments = bare.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const raw of bare.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
    } else if (segment && segment !== '.') segments.push(segment);
  }
  const path = normalizeSpacePath(segments.join('/'));
  return path ? { path, hash } : null;
}

/** The absolute URL of a file's bytes; `version` (its SHA-256) keeps caches from serving an older one. */
export const rawUrl = (origin: string, shareToken: string, path: string, version?: string) =>
  `${origin}${SPACE_PUBLIC_ROUTES.raw(shareToken, path)}${version ? `?v=${version.slice(0, 16)}` : ''}`;

/** The raw folder a file's relative URLs resolve against, with its trailing `/`. */
export const rawDirUrl = (origin: string, shareToken: string, dir: string) =>
  `${origin}${SPACE_PUBLIC_ROUTES.raw(shareToken, dir)}${dir ? '/' : ''}`;

const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * `html` with `<base href>` first in its `<head>`, so relative URLs load from the Space's raw routes
 * inside an opaque `srcdoc` iframe. Without a `<head>` it adds one, after `<html>` or the doctype.
 */
export function withBaseHref(html: string, href: string): string {
  const base = `<base href="${escapeAttribute(href)}">`;
  const head = /<head(?=[\s>])[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + base + html.slice(head.index + head[0].length);
  const opening = /<html(?=[\s>])[^>]*>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
  const at = opening ? opening.index + opening[0].length : 0;
  return `${html.slice(0, at)}<head>${base}</head>${html.slice(at)}`;
}

/** `1.2 MB`, in 1024s. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`;
}
