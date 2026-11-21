import { trackAgents } from '@databuddy/sdk/agents';
import { waitUntil } from 'cloudflare:workers';
import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { api } from './api';
import type { Env } from './env';
import { spacesRoute } from './spaces/routing';
import { spacesService } from './spaces/service';
import { skillsService } from './skills/service';

// Durable Object classes must be exported from the Worker's main module.
export { SpaceHub } from './spaces/hub';

/**
 * Outgoing requests one scheduled run may spend on Skills update checks. A Worker invocation may make
 * 50 on the Free plan; the rest is headroom. Each run checks the Skills not checked for about a day,
 * as many as fit, every 10 minutes.
 */
const SKILLS_REQUEST_BUDGET = 40;
/** Expired Spaces one scheduled run may purge: each costs a few R2 and D1 calls. */
const SPACES_PURGE_BUDGET = 10;

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

    if (isApiPath(pathname) || spacesRoute(pathname, request.headers.get('Accept')) === 'api') {
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
    }).catch((error: unknown) => console.error('[skills] update check failed:', error)));
    ctx.waitUntil(spacesService(env).purge(new Date(), SPACES_PURGE_BUDGET).then((purged) => {
      if (purged) console.log(`[spaces] purged ${purged} expired Spaces`);
    }).catch((error: unknown) => console.error('[spaces] purge failed:', error)));
  }) satisfies ExportedHandlerScheduledHandler<Env>,
};
