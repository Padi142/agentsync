/**
 * Content types of Space files: what to store when an upload names none, which are text
 * (for the Markdown digest), and which are safe to show inline from `/s/<token>/raw/*`.
 */

const BY_EXTENSION: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  rs: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
  toml: 'text/plain; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  json: 'application/json',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  zip: 'application/zip',
  apk: 'application/vnd.android.package-archive',
};

const GENERIC = 'application/octet-stream';
/** `type/subtype` with optional parameters, as an upload's `Content-Type` must be to be kept. */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;.*)?$/;

/** The `type/subtype` part of a content type, lowercased. */
export const mimeEssence = (contentType: string) => contentType.split(';')[0]!.trim().toLowerCase();

/**
 * What to store for an upload. A known extension decides, so `.html` is always served as HTML (an
 * attachment) and `.png` as an image whatever the upload claims; otherwise the declared `Content-Type`,
 * unless missing or malformed.
 */
export function contentTypeFor(path: string, declared: string | null | undefined): string {
  const extension = path.slice(path.lastIndexOf('/') + 1).split('.').slice(1).pop()?.toLowerCase();
  const known = extension && BY_EXTENSION[extension];
  if (known) return known;
  const type = declared?.trim().toLowerCase();
  return type && type.length <= 255 && MIME.test(type) ? type : GENERIC;
}

const TEXT_APPLICATION = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/yaml', 'application/toml', 'application/x-sh',
]);

/** Whether a file of this type reads as text. */
export function isTextType(contentType: string) {
  const essence = mimeEssence(contentType);
  return essence.startsWith('text/') || TEXT_APPLICATION.has(essence) || essence.endsWith('+json');
}

/**
 * Types a browser shows without running anything: served inline from the raw route. Everything else,
 * HTML and SVG included, is served as an attachment (and every raw response gets a sandbox CSP).
 */
const INERT = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/css', 'text/javascript', 'text/yaml',
  'application/json', 'application/javascript', 'application/wasm',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/bmp',
  'font/woff', 'font/woff2', 'font/ttf', 'font/otf',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'video/mp4', 'video/webm',
]);

export const isInertType = (contentType: string) => INERT.has(mimeEssence(contentType));
