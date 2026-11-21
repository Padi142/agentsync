/** The highest `q` an `Accept` header gives any of `types` (0 if it lists none of them). Wildcards are ignored. */
export function acceptQuality(accept: string, types: string[]) {
  let best = 0;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (!type || !types.includes(type)) continue;
    const q = params.find((param) => param.startsWith('q='));
    const value = q ? Number(q.slice(2)) : 1;
    if (Number.isFinite(value)) best = Math.max(best, value);
  }
  return best;
}

/**
 * Whether the Worker answers a request under `/s/*`, `/api/spaces/*` or `/api/owner/spaces/*` itself
 * (`api`) or leaves it to TanStack (`app`), or it isn't a Spaces path at all (`null`). Only a browser
 * opening a Share Link (`/s/<token>`, with or without a trailing `/`, no suffix) that asks for
 * `text/html` more than for Markdown or JSON gets the web viewer, the SPA route `/s/$shareToken`;
 * agents asking the same URL for Markdown or JSON, and every suffix and subpath, get the API.
 */
export function spacesRoute(pathname: string, accept: string | null): 'api' | 'app' | null {
  if (pathname === '/api/spaces' || pathname.startsWith('/api/spaces/') ||
      pathname === '/api/owner/spaces' || pathname.startsWith('/api/owner/spaces/')) {
    return 'api';
  }
  if (!pathname.startsWith('/s/')) return null;
  if (!/^\/s\/[^/.]+\/?$/.test(pathname)) return 'api';
  const html = acceptQuality(accept ?? '', ['text/html']);
  return html > 0 && html > acceptQuality(accept ?? '', ['text/markdown', 'application/json']) ? 'app' : 'api';
}
