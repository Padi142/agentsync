/**
 * Whether the Worker answers a request under `/s/*` or `/api/spaces/*` itself (`api`) or leaves it to
 * TanStack (`app`), or it isn't a Spaces path at all (`null`). Only a browser opening a Share Link
 * (`/s/<token>`, no suffix, `Accept: text/html`) gets the web viewer, the SPA route `/s/$shareToken`;
 * agents asking the same URL for Markdown or JSON, and every suffix and subpath, get the API.
 */
export function spacesRoute(pathname: string, accept: string | null): 'api' | 'app' | null {
  if (pathname === '/api/spaces' || pathname.startsWith('/api/spaces/')) return 'api';
  if (!pathname.startsWith('/s/')) return null;
  const viewer = /^\/s\/[^/.]+$/.test(pathname) && (accept ?? '').includes('text/html');
  return viewer ? 'app' : 'api';
}
