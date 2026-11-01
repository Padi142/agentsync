import { trackAgents } from '@databuddy/sdk/agents';
import { waitUntil } from 'cloudflare:workers';
import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { api } from './api';
import type { Env } from './env';
import { skillsService } from './skills/service';

/**
 * Skills each scheduled run checks for updates. Every run checks those not checked for about a day, so
 * with the trigger every 10 minutes this covers about 576 Skills a day, while one run stays well inside
 * the Worker's subrequest limit (a check takes 3 GitHub and skills.sh calls, up to 13).
 */
const SKILLS_PER_RUN = 4;

const isApiPath = (pathname: string) =>
  pathname === '/rpc' ||
  pathname.startsWith('/rpc/') ||
  pathname === '/login' ||
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
    ctx.waitUntil(skillsService(env).checkStale(SKILLS_PER_RUN).then(({ checked, of }) => {
      if (of) console.log(`[skills] checked ${checked} of ${of} Skills for updates`);
    }));
  }) satisfies ExportedHandlerScheduledHandler<Env>,
};
