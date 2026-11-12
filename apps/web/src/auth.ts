import {
  BadRequestException, RateLimitExceededException, UnprocessableEntityException, WorkOS,
  type AuthenticationResponse,
} from '@workos-inc/node';
import type { Context } from 'hono';
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { findUser, provisionUser, type AppUser } from './db/users';
import type { Env } from './env';
import type { EmailLoginError } from './login';
import { SIGNUP_COOKIE } from './signup';
import { z } from 'zod';

const SESSION_COOKIE = 'wos-session';
const LOGIN_COOKIE = 'wos-login';
const LOGIN_TTL = 10 * 60;
const SESSION_TTL = 30 * 24 * 60 * 60;
type AuthContext = Context<{ Bindings: Env }>;
export type AuthSession = { user: AppUser | null };

export function getAppOrigin(env: Env) {
  return new URL(env.WORKOS_REDIRECT_URI).origin;
}

function getWorkOS(env: Env) {
  if (!env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID || (env.WORKOS_COOKIE_PASSWORD?.length ?? 0) < 32) {
    throw new HTTPException(503, { message: 'Authentication is not configured.' });
  }
  const callback = new URL(env.WORKOS_REDIRECT_URI);
  if (callback.pathname !== '/callback' || callback.search || callback.hash) {
    throw new HTTPException(503, { message: 'WORKOS_REDIRECT_URI must point to /callback.' });
  }
  return new WorkOS(env.WORKOS_API_KEY, { clientId: env.WORKOS_CLIENT_ID });
}

function cookieOptions(c: AuthContext) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: new URL(c.env.WORKOS_REDIRECT_URI).protocol === 'https:',
  };
}

function setSession(c: AuthContext, value: string) {
  setCookie(c, SESSION_COOKIE, value, { ...cookieOptions(c), maxAge: SESSION_TTL });
}

function clearSession(c: AuthContext) {
  deleteCookie(c, SESSION_COOKIE, cookieOptions(c));
}

const MAX_RETURN_PATH = 512;
const SAFE_PATH = /^\/(?![/\\])[^\s\\\x00-\x1f\x7f]*$/;

/**
 * `value` if it is a path on this app to return to after sign-in, otherwise `/`. Only a single
 * leading `/` is allowed: `//host` and `/\host` are other origins to a browser, and browsers drop
 * tabs and newlines from URLs, so whitespace, control characters and backslashes are rejected too.
 * The path is returned as a browser sends it, percent-encoded, and dropped if that form is longer
 * than 512 characters: it rides in the login cookie, and a browser that refuses an oversized cookie
 * would lose the OAuth state with it. Counting the encoded form keeps `界` (9 characters encoded)
 * from slipping under a limit meant for ASCII. The resolved path is checked again, because
 * resolving dot segments can turn `/a/..//host` into `//host`.
 */
export function returnPath(value: string | undefined, origin: string): string {
  if (!value || !SAFE_PATH.test(value)) return '/';
  const url = new URL(value, origin);
  const path = url.pathname + url.search + url.hash;
  return url.origin === origin && SAFE_PATH.test(path) && path.length <= MAX_RETURN_PATH ? path : '/';
}

/** Our sign-in dialog's buttons, as WorkOS names them. Anything else gets WorkOS's hosted page. */
const PROVIDERS: Record<string, string> = { google: 'GoogleOAuth', github: 'GitHubOAuth' };

/**
 * `GET /login?provider=google|github` goes straight to that provider, so people never see the
 * hosted AuthKit page. Without a provider (a login WorkOS itself starts) it goes to that page.
 */
export async function handleLogin(c: AuthContext) {
  const workos = getWorkOS(c.env);
  const origin = getAppOrigin(c.env);
  const returnTo = returnPath(c.req.query('returnTo'), origin);
  // The login cookie and callback must live on the same origin.
  if (new URL(c.req.url).origin !== origin) {
    const query = new URL(c.req.url).search;
    return c.redirect(`${origin}/login${query}`);
  }

  const { url, state, codeVerifier } = await workos.userManagement.getAuthorizationUrlWithPKCE({
    provider: PROVIDERS[c.req.query('provider') ?? ''] ?? 'authkit',
    clientId: c.env.WORKOS_CLIENT_ID,
    redirectUri: c.env.WORKOS_REDIRECT_URI,
  });
  await setSignedCookie(c, LOGIN_COOKIE, JSON.stringify({
    state, codeVerifier, returnTo, expiresAt: Date.now() + LOGIN_TTL * 1000,
  }), c.env.WORKOS_COOKIE_PASSWORD, { ...cookieOptions(c), maxAge: LOGIN_TTL });
  return c.redirect(url);
}

export async function handleCallback(c: AuthContext) {
  const workos = getWorkOS(c.env);
  const state = c.req.query('state');
  let login: { state?: unknown; codeVerifier?: unknown; returnTo?: unknown; expiresAt?: unknown } | null = null;
  try {
    const value = await getSignedCookie(c, c.env.WORKOS_COOKIE_PASSWORD, LOGIN_COOKIE);
    if (value) login = JSON.parse(value);
  } catch {
    // Malformed or tampered login cookies cannot complete the exchange.
  }
  deleteCookie(c, LOGIN_COOKIE, cookieOptions(c));
  if (!login || !state || state !== login.state ||
      typeof login.codeVerifier !== 'string' ||
      typeof login.expiresAt !== 'number' || login.expiresAt <= Date.now()) {
    return c.text('Sign-in expired or could not be verified. Please start again at /login.', 400);
  }
  if (c.req.query('error')) return c.redirect('/?authError=cancelled', 303);
  const code = c.req.query('code');
  if (!code) return c.text('No authorization code provided.', 400);

  try {
    const result = await workos.userManagement.authenticateWithCode({
      clientId: c.env.WORKOS_CLIENT_ID,
      code,
      codeVerifier: login.codeVerifier,
      session: { sealSession: true, cookiePassword: c.env.WORKOS_COOKIE_PASSWORD },
    });
    await startSession(c, result);
    // Checked again on the way out, so the redirect never leaves the app.
    const returnTo = typeof login.returnTo === 'string' ? login.returnTo : undefined;
    return c.redirect(returnPath(returnTo, getAppOrigin(c.env)), 303);
  } catch {
    // Never log the code, tokens, or provider error payloads.
    console.error('[AuthKit] Callback failed. Check WorkOS configuration and local user provisioning.');
    return c.redirect('/?authError=callback', 303);
  }
}

/** Provision the local user for a completed WorkOS sign-in and set the session cookie. */
async function startSession(c: AuthContext, result: AuthenticationResponse) {
  if (!result.sealedSession) throw new Error('Missing sealed session');
  const isNew = !await findUser(c.env, result.user.id);
  await provisionUser(c.env, result.user);
  // Readable by the page, which reports the sign-up and removes it.
  if (isNew) setCookie(c, SIGNUP_COOKIE, '1', { ...cookieOptions(c), httpOnly: false, maxAge: LOGIN_TTL });
  setSession(c, result.sealedSession);
}

/** What WorkOS's Radar uses to spot abuse of the email endpoints. */
const requester = (c: AuthContext) => ({
  ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
});

const EmailStart = z.object({ email: z.email().max(254) });
const EmailVerify = EmailStart.extend({
  code: z.string().trim().regex(/^\d{6}$/),
  returnTo: z.string().optional(),
});
const emailError = (c: AuthContext, error: EmailLoginError, status: 400 | 429 | 503) => c.json({ error }, status);

/** `POST /login/email`: email a six-digit code (WorkOS Magic Auth) to sign in or sign up with. */
export async function handleEmailStart(c: AuthContext) {
  const workos = getWorkOS(c.env);
  const input = EmailStart.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return emailError(c, 'invalid_email', 400);
  try {
    await workos.userManagement.createMagicAuth({ email: input.data.email, ...requester(c) });
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof UnprocessableEntityException) return emailError(c, 'invalid_email', 400);
    if (error instanceof RateLimitExceededException) return emailError(c, 'too_many', 429);
    // Magic Auth is switched off in this WorkOS environment.
    if (error instanceof BadRequestException) return emailError(c, 'unavailable', 503);
    console.error('[AuthKit] Could not send a sign-in code.');
    return emailError(c, 'unavailable', 503);
  }
}

/** `POST /login/email/verify`: exchange the emailed code for a session, and say where to go next. */
export async function handleEmailVerify(c: AuthContext) {
  const workos = getWorkOS(c.env);
  const input = EmailVerify.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return emailError(c, 'invalid_code', 400);
  let result: AuthenticationResponse;
  try {
    result = await workos.userManagement.authenticateWithMagicAuth({
      clientId: c.env.WORKOS_CLIENT_ID,
      code: input.data.code,
      email: input.data.email,
      session: { sealSession: true, cookiePassword: c.env.WORKOS_COOKIE_PASSWORD },
      ...requester(c),
    });
  } catch (error) {
    if (error instanceof RateLimitExceededException) return emailError(c, 'too_many', 429);
    // A wrong, used or expired code, or an email no code was sent to.
    if (typeof (error as { status?: unknown }).status === 'number' && (error as { status: number }).status < 500) {
      return emailError(c, 'invalid_code', 400);
    }
    console.error('[AuthKit] Could not verify a sign-in code.');
    return emailError(c, 'unavailable', 503);
  }
  await startSession(c, result);
  return c.json({ returnTo: returnPath(input.data.returnTo, getAppOrigin(c.env)) });
}

async function authenticate(c: AuthContext) {
  const sessionData = getCookie(c, SESSION_COOKIE);
  if (!sessionData) return null;
  const workos = getWorkOS(c.env);
  const session = workos.userManagement.loadSealedSession({
    sessionData, cookiePassword: c.env.WORKOS_COOKIE_PASSWORD,
  });
  const result = await session.authenticate();
  if (result.authenticated) return { result, workos };
  if (result.reason !== 'invalid_jwt') {
    clearSession(c);
    return null;
  }

  const refreshed = await session.refresh();
  if (!refreshed.authenticated) {
    if (refreshed.retryable) {
      // A provider outage must not destroy an otherwise recoverable session.
      throw new HTTPException(503, { message: 'Sign-in is temporarily unavailable. Please try again.' });
    }
    clearSession(c);
    return null;
  }
  if (!refreshed.sealedSession) throw new HTTPException(503);
  setSession(c, refreshed.sealedSession);
  return { result: refreshed, workos };
}

export async function getSession(c: AuthContext): Promise<AuthSession> {
  const authenticated = await authenticate(c);
  if (!authenticated) return { user: null };
  const identity = authenticated.result.user;
  const user = await findUser(c.env, identity.id) ?? await provisionUser(c.env, identity);
  return { user };
}

export async function handleLogout(c: AuthContext) {
  const authenticated = await authenticate(c);
  clearSession(c);
  if (!authenticated) return c.redirect('/', 303);
  const url = authenticated.workos.userManagement.getLogoutUrl({
    sessionId: authenticated.result.sessionId,
    returnTo: `${getAppOrigin(c.env)}/`,
  });
  return c.redirect(url, 303);
}
