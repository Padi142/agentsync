import { onError, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { router, createRPCContext } from './router';
import { spacesApi } from './spaces';
import {
  getAppOrigin, handleLogin, handleCallback, handleLogout, handleEmailStart, handleEmailVerify, getSession,
  type AuthSession,
} from '../auth';
import type { Env } from '../env';

type HonoEnv = { Bindings: Env };
const rpcHandler = new RPCHandler(router, {
  interceptors: [onError(() => console.error('[oRPC] Request failed.'))],
});
export const api = new Hono<HonoEnv>();

api.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  // Browsers send Origin on every POST. A request with neither Origin nor cookies (the CLI)
  // carries no ambient credentials, so it cannot be a cross-site forgery. The Space Write Token
  // routes ignore cookies anyway; a browser's cookies there mean it isn't the CLI, so they're refused too.
  const origin = c.req.header('Origin');
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (unsafe && (origin ? origin !== getAppOrigin(c.env) : c.req.header('Cookie') !== undefined)) {
    return c.json({ error: 'Invalid request origin.' }, 403);
  }
  if (unsafe && c.req.path.startsWith('/api/spaces/') && c.req.header('Cookie') !== undefined) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Use a Write Token, not cookies.' } }, 401);
  }
  await next();
});

api.get('/login', handleLogin);
api.post('/login/email', handleEmailStart);
api.post('/login/email/verify', handleEmailVerify);
api.get('/callback', handleCallback);
api.post('/logout', handleLogout);
api.get('/api/auth/get-session', async (c) => c.json(await getSession(c)));

api.use('/rpc/*', async (c, next) => {
  let session: Promise<AuthSession> | undefined;
  // Loaded only when a procedure needs it. Inside oRPC, keep the status of auth failures
  // such as a 503 during a WorkOS outage instead of turning them into a 500.
  const loadSession = () => session ??= getSession(c).catch((error: unknown) => {
    if (!(error instanceof HTTPException)) throw error;
    throw new ORPCError(error.status === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_SERVER_ERROR', {
      status: error.status, message: error.message,
    });
  });
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: '/rpc',
    context: createRPCContext(c.req.raw, c.env, loadSession),
  });
  if (matched) return c.newResponse(response.body, response);
  await next();
});
api.route('/', spacesApi);
api.all('*', (c) => c.notFound());
