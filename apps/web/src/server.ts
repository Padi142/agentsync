import { trackAgents } from '@databuddy/sdk/agents';
import { waitUntil } from 'cloudflare:workers';
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
    // Crawlers like GPTBot and ClaudeBot never run JavaScript, so they are recorded here.
    waitUntil(trackAgents(request, { websiteId: (env as Env).DATABUDDY_WEBSITE_ID }));
    const { pathname } = new URL(request.url);

    if (isApiPath(pathname)) {
      return api.fetch(request, env as Env);
    }

    return handler.fetch(request);
  },
});
