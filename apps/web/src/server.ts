import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { api } from './api';
import type { Env } from './env';

const isApiPath = (pathname: string) =>
  pathname === '/rpc' ||
  pathname.startsWith('/rpc/') ||
  pathname === '/login' ||
  pathname === '/callback' ||
  pathname === '/logout' ||
  pathname === '/api/auth/get-session';

export default createServerEntry({
  fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (isApiPath(pathname)) {
      return api.fetch(request, env as Env);
    }

    return handler.fetch(request);
  },
});
