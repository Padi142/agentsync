import { parseShareUrl, SPACE_PUBLIC_ROUTES, type PublicSpace } from '@agentsync/contract';
import { isTextType, mimeEssence } from './content-type';

/** Markdown and HTML files up to this size are read for their outline. */
const OUTLINE_MAX_BYTES = 256 * 1024;
const OUTLINE_MAX_ITEMS = 40;
/** A Space whose only file is text and at most this big is inlined in full. */
const INLINE_SINGLE_MAX_BYTES = 100 * 1024;
/** A Space of text files only, together at most this big, is inlined in full. */
const INLINE_ALL_MAX_BYTES = 32 * 1024;

/** `1.2 KB`, `3.4 MB`: binary units, one decimal. */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const utc = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const isMarkdown = (path: string, type: string) => mimeEssence(type) === 'text/markdown' || /\.(md|markdown)$/i.test(path);
const isHtml = (path: string, type: string) => mimeEssence(type) === 'text/html' || /\.html?$/i.test(path);

/** Headings outside fenced code, and the top-level keys of YAML frontmatter, of a Markdown file. */
function markdownOutline(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const outline: string[] = [];
  let start = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (match) outline.push(`${match[1]}: ${truncate(match[2]!.trim() || '…', 100)}`);
      }
      start = end + 1;
    }
  }
  let fence: string | null = null;
  for (const line of lines.slice(start)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) {
      fence = fence ? null : marker;
      continue;
    }
    const heading = !fence && line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) outline.push(`${heading[1]} ${heading[2]}`);
  }
  return outline;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const htmlText = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITIES[name]!)
  .replace(/\s+/g, ' ').trim();

/** The `<title>` and `<h1>`–`<h6>` of an HTML file, as Markdown headings. */
function htmlOutline(html: string): string[] {
  const visible = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  const outline: string[] = [];
  const title = visible.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (title && htmlText(title[1]!)) outline.push(`title: ${htmlText(title[1]!)}`);
  for (const match of visible.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const text = htmlText(match[2]!);
    if (text) outline.push(`${'#'.repeat(Number(match[1]))} ${text}`);
  }
  return outline;
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A code fence longer than any backtick run in `text`. */
const fenceFor = (text: string) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

const LANGUAGES: Record<string, string> = { md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', json: 'json', css: 'css', js: 'js', ts: 'ts', py: 'python', yaml: 'yaml', yml: 'yaml', svg: 'xml', xml: 'xml', sh: 'sh' };

interface Dir {
  files: PublicSpace['files'];
  dirs: Map<string, Dir>;
}

/**
 * The Markdown digest of a Space (`GET /s/<token>.md`): what an agent reads to understand it.
 * Title, summary, status and expiry, links, a file tree with sizes, types and raw URLs, outlines
 * of Markdown and HTML files, and the full text of small text-only Spaces. Deterministic: the same
 * Space and contents give the same text. `readText` returns a file's contents, or `null`.
 */
export async function spaceDigest(space: PublicSpace, readText: (path: string) => Promise<string | null>): Promise<string> {
  const link = parseShareUrl(space.shareUrl);
  if (!link) throw new Error(`Not a Share Link: ${space.shareUrl}`);
  const url = (route: string) => `${link.origin}${route}`;
  const files = [...space.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const allText = files.length > 0 && files.every((file) => isTextType(file.contentType));
  const textBytes = files.reduce((sum, file) => sum + file.size, 0);
  const inline = allText && (files.length === 1 ? textBytes <= INLINE_SINGLE_MAX_BYTES : textBytes <= INLINE_ALL_MAX_BYTES);

  const contents = new Map<string, string>();
  for (const file of files) {
    const outlined = (isMarkdown(file.path, file.contentType) || isHtml(file.path, file.contentType)) && file.size <= OUTLINE_MAX_BYTES;
    if (!inline && !outlined) continue;
    const text = await readText(file.path);
    if (text !== null) contents.set(file.path, text);
  }

  const out: string[] = [`# ${space.title}`, ''];
  if (space.summary) out.push(...space.summary.split('\n').map((line) => `> ${line}`.trimEnd()), '');
  const status = space.status === 'active'
    ? space.expiresAt ? `active until ${utc(space.expiresAt)}` : 'active, permanent'
    : space.status;
  out.push(
    `- Status: ${status}`,
    `- Files: ${files.length} (${formatBytes(space.totalBytes)})`,
    `- Updated: ${utc(space.updatedAt)}`,
    `- Share Link: ${space.shareUrl}`,
    `- JSON: ${url(SPACE_PUBLIC_ROUTES.json(link.shareToken))}`,
    `- Download all: ${url(SPACE_PUBLIC_ROUTES.zip(link.shareToken))}`,
    '',
    '## Files',
    '',
  );
  if (!files.length) out.push('No files yet.');

  const root: Dir = { files: [], dirs: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) dir.dirs.set(part, next = { files: [], dirs: new Map() });
      dir = next;
    }
    dir.files.push(file);
  }
  const writeDir = (dir: Dir, depth: number) => {
    const indent = '  '.repeat(depth);
    for (const file of dir.files) {
      const name = file.path.slice(file.path.lastIndexOf('/') + 1);
      out.push(`${indent}- [\`${name}\`](${url(SPACE_PUBLIC_ROUTES.raw(link.shareToken, file.path))}) — ${formatBytes(file.size)}, ${mimeEssence(file.contentType)}`);
      const text = contents.get(file.path);
      if (text === undefined) continue;
      const outline = isMarkdown(file.path, file.contentType) ? markdownOutline(text)
        : isHtml(file.path, file.contentType) ? htmlOutline(text) : [];
      for (const item of outline.slice(0, OUTLINE_MAX_ITEMS)) out.push(`${indent}  - ${truncate(item, 200)}`);
      if (outline.length > OUTLINE_MAX_ITEMS) out.push(`${indent}  - … ${outline.length - OUTLINE_MAX_ITEMS} more`);
    }
    for (const [name, child] of [...dir.dirs].sort(([a], [b]) => (a < b ? -1 : 1))) {
      out.push(`${indent}- \`${name}/\``);
      writeDir(child, depth + 1);
    }
  };
  writeDir(root, 0);

  if (inline && contents.size) {
    out.push('', '## Contents');
    for (const file of files) {
      const text = contents.get(file.path);
      if (text === undefined) continue;
      const fence = fenceFor(text);
      const extension = file.path.split('.').pop()?.toLowerCase() ?? '';
      out.push('', `### ${file.path}`, '', `${fence}${LANGUAGES[extension] ?? ''}`, text.replace(/\n$/, ''), fence);
    }
  }
  return `${out.join('\n')}\n`;
}
