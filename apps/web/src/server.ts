import { trackAgents } from '@databuddy/sdk/agents';
import { waitUntil } from 'cloudflare:workers';
import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { api } from './api';
import type { Env } from './env';
import { skillsService } from './skills/service';

/**
 * Outgoing requests one scheduled run may spend on Skills update checks. A Worker invocation may make
 * 50 on the Free plan; the rest is headroom. Each run checks the Skills not checked for about a day,
 * as many as fit, every 10 minutes.
 */
const SKILLS_REQUEST_BUDGET = 40;

const isApiPath = (pathname: string) =>
  pathname === '/rpc' ||
  pathname.startsWith('/rpc/') ||
  pathname === '/login' ||
  pathname.startsWith('/login/') ||
  pathname === '/callback' ||
  pathname === '/logout' ||
  pathname === '/api/auth/get-session';

const app = createServerEntry({
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

// TanStack's createServerEntry returns only `{ fetch }`, so the cron handler sits beside it.
export default {
  ...app,
  scheduled: ((_controller, env, ctx) => {
    ctx.waitUntil(skillsService(env).checkStale(SKILLS_REQUEST_BUDGET).then(({ checked, stale }) => {
      if (stale) console.log(`[skills] checked ${checked} of ${stale} stale Skills for updates`);
    }));
  }) satisfies ExportedHandlerScheduledHandler<Env>,
};
