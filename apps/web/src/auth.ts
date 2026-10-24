import { WorkOS } from '@workos-inc/node';
import type { Env } from './env';

const SESSION_COOKIE = 'wos-session';

export interface WorkOSUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface AuthSession {
  user: WorkOSUser | null;
}

function getWorkOS(env: Env) {
  return new WorkOS(env.WORKOS_API_KEY, {
    clientId: env.WORKOS_CLIENT_ID,
  });
}

export function getAuthorizationUrl(env: Env): string {
  const workos = getWorkOS(env);
  return workos.userManagement.getAuthorizationUrl({
    provider: 'authkit',
    redirectUri: env.WORKOS_REDIRECT_URI,
    clientId: env.WORKOS_CLIENT_ID,
  });
}

export async function handleCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return new Response('No authorization code provided', { status: 400 });
  }

  try {
    const workos = getWorkOS(env);
    const result = await workos.userManagement.authenticateWithCode({
      clientId: env.WORKOS_CLIENT_ID,
      code,
      session: {
        sealSession: true,
        cookiePassword: env.WORKOS_COOKIE_PASSWORD,
      },
    });

    const headers = new Headers();
    headers.set('Location', '/');
    headers.set(
      'Set-Cookie',
      `${SESSION_COOKIE}=${result.sealedSession}; Path=/; HttpOnly; SameSite=Lax`
    );

    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.error('[WorkOS callback error]', error);
    return new Response(null, {
      status: 302,
      headers: { Location: '/login' },
    });
  }
}

export async function getSession(
  request: Request,
  env: Env
): Promise<AuthSession> {
  const cookieHeader = request.headers.get('Cookie') ?? '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [key, ...rest] = c.trim().split('=');
      return [key, rest.join('=')];
    })
  );

  const sessionData = cookies[SESSION_COOKIE];
  if (!sessionData) {
    return { user: null };
  }

  try {
    const workos = getWorkOS(env);
    const session = workos.userManagement.loadSealedSession({
      sessionData,
      cookiePassword: env.WORKOS_COOKIE_PASSWORD,
    });

    const authResult = await session.authenticate();

    if (authResult.authenticated) {
      const user = authResult.user;
      return {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
      };
    }

    // Authentication failed
    return { user: null };
  } catch (error) {
    console.error('[WorkOS session error]', error);
    return { user: null };
  }
}

export async function handleLogout(
  request: Request,
  env: Env
): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie') ?? '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [key, ...rest] = c.trim().split('=');
      return [key, rest.join('=')];
    })
  );

  const sessionData = cookies[SESSION_COOKIE];

  // Clear the session cookie regardless
  const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

  if (!sessionData) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': clearCookie,
      },
    });
  }

  try {
    const workos = getWorkOS(env);
    const session = workos.userManagement.loadSealedSession({
      sessionData,
      cookiePassword: env.WORKOS_COOKIE_PASSWORD,
    });

    // Get the WorkOS logout URL which will end the AuthKit session
    const logoutUrl = await session.getLogoutUrl();

    return new Response(null, {
      status: 302,
      headers: {
        Location: logoutUrl,
        'Set-Cookie': clearCookie,
      },
    });
  } catch (error) {
    console.error('[WorkOS logout error]', error);
    // On error, just clear cookie and redirect home
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': clearCookie,
      },
    });
  }
}
