import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { createDb } from './db';
import { schema } from './db/schema';
import type { Env } from './env';

export function createAuth(env: Env, request: Request) {
  const origin = env.BETTER_AUTH_URL || new URL(request.url).origin;

  return betterAuth({
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],
    database: drizzleAdapter(createDb(env), {
      provider: 'sqlite',
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    advanced: {
      database: {
        validateSchema: false,
      },
    },
  });
}

export async function getSession(request: Request, env: Env) {
  const auth = createAuth(env, request);
  return auth.api.getSession({ headers: request.headers });
}

export type AuthSession = Awaited<ReturnType<typeof getSession>>;
