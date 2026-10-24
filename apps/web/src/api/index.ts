import { onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { Hono } from 'hono';
import { router, createRPCContext } from './router';
import {
  getAuthorizationUrl,
  handleCallback,
  handleLogout,
  getSession,
} from '../auth';
import type { Env } from '../env';

type HonoEnv = { Bindings: Env };

const rpcHandler = new RPCHandler(router, {
  interceptors: [
    onError((error) => {
      console.error('[oRPC]', error);
    }),
  ],
});

export const api = new Hono<HonoEnv>();

// WorkOS AuthKit routes
api.get('/login', (c) => {
  const authUrl = getAuthorizationUrl(c.env);
  return c.redirect(authUrl);
});

api.get('/callback', async (c) => {
  return handleCallback(c.req.raw, c.env);
});

api.post('/logout', async (c) => {
  return handleLogout(c.req.raw, c.env);
});

api.get('/api/auth/get-session', async (c) => {
  const session = await getSession(c.req.raw, c.env);
  if (!session.user) {
    return c.json({ user: null });
  }
  // Map WorkOS user to expected format
  const name = [session.user.firstName, session.user.lastName]
    .filter(Boolean)
    .join(' ') || session.user.email;
  return c.json({
    user: {
      id: session.user.id,
      name,
      email: session.user.email,
    },
  });
});

api.use('/rpc/*', async (c, next) => {
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: '/rpc',
    context: await createRPCContext(c.req.raw, c.env),
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  await next();
});

api.all('*', (c) => c.notFound());
