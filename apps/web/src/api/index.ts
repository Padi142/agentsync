import { onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { Hono } from 'hono';
import { router, createRPCContext } from './router';
import { createAuth } from '../auth';
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

api.on(['GET', 'POST', 'OPTIONS'], ['/api/auth', '/api/auth/*'], async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return auth.handler(c.req.raw);
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
