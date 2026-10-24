import { onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { Hono } from 'hono';
import { router, createRPCContext } from './router';
import { getAppOrigin, handleLogin, handleCallback, handleLogout, getSession } from '../auth';
import type { Env } from '../env';

type HonoEnv = { Bindings: Env };
const rpcHandler = new RPCHandler(router, {
  interceptors: [onError(() => console.error('[oRPC] Request failed.'))],
});
export const api = new Hono<HonoEnv>();

api.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      c.req.header('Origin') !== getAppOrigin(c.env)) {
    return c.json({ error: 'Invalid request origin.' }, 403);
  }
  await next();
});

api.get('/login', handleLogin);
api.get('/callback', handleCallback);
api.post('/logout', handleLogout);
api.get('/api/auth/get-session', async (c) => c.json(await getSession(c)));

api.use('/rpc/*', async (c, next) => {
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: '/rpc',
    context: createRPCContext(c.req.raw, c.env, await getSession(c)),
  });
  if (matched) return c.newResponse(response.body, response);
  await next();
});
api.all('*', (c) => c.notFound());
