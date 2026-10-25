import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { provisionUser } from '../src/db/users';
import type { Env } from '../src/env';
import { createTestEnv, fakeWorkOSDevice, origin, resetDb, rpcClient } from './helpers';

const sdk = vi.hoisted(() => ({
  exchange: vi.fn(), authenticate: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
}));
vi.mock('@workos-inc/node', async (importOriginal) => {
  const { WorkOS } = await importOriginal<typeof import('@workos-inc/node')>();
  return { WorkOS: class extends WorkOS {
    constructor(...args: ConstructorParameters<typeof WorkOS>) {
      super(...args);
      this.userManagement.authenticateWithCode = sdk.exchange;
      this.userManagement.loadSealedSession = vi.fn(() => ({
        authenticate: sdk.authenticate, refresh: sdk.refresh,
      })) as never;
      this.userManagement.getLogoutUrl = sdk.logout;
    }
  } };
});

let env: Env;
const identity = {
  id: 'user_workos_alice', email: 'alice@example.com', firstName: 'Alice', lastName: null,
  emailVerified: true, profilePictureUrl: null,
} as Parameters<typeof provisionUser>[1];
let mf: Miniflare;

beforeAll(async () => {
  ({ mf, env } = await createTestEnv());
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb(env);
  sdk.authenticate.mockResolvedValue({ authenticated: true, user: identity, sessionId: 'session_fixture' });
  sdk.exchange.mockResolvedValue({ user: identity, sealedSession: 'sealed-fixture' });
  sdk.logout.mockReturnValue('https://api.workos.com/user_management/sessions/logout');
});

async function login(returnTo?: string) {
  const query = returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;
  const res = await api.request(`${origin}/login${query}`, {}, env);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('wos-login='))!;
  const url = new URL(res.headers.get('Location')!);
  return { res, cookie: cookie.split(';')[0], url, state: url.searchParams.get('state')! };
}
function callback(cookie: string, query: string) {
  return api.request(`${origin}/callback?${query}`, { headers: { Cookie: cookie } }, env);
}
function sessionRequest(cookie = 'wos-session=sealed-fixture') {
  return api.request(`${origin}/api/auth/get-session`, { headers: { Cookie: cookie } }, env);
}
const client = () => rpcClient(env, { cookie: 'wos-session=sealed-fixture' });

describe('AuthKit routes', () => {
  it('starts login immediately with the explicit callback and PKCE', async () => {
    const { res, url } = await login();
    expect(res.status).toBe(302);
    expect(url.searchParams.get('redirect_uri')).toBe(env.WORKOS_REDIRECT_URI);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });
  it('uses Secure cookies on HTTPS', async () => {
    const res = await api.request('https://app.test/login', {}, { ...env, WORKOS_REDIRECT_URI: 'https://app.test/callback' });
    expect(res.headers.get('Set-Cookie')).toContain('Secure');
  });
  it('rejects callbacks without the browser login cookie or matching state', async () => {
    const { cookie } = await login();
    for (const [c, q] of [['', 'code=code&state=state'], [cookie, 'code=code&state=wrong'], ['wos-login=tampered', 'code=code&state=state']]) {
      expect((await callback(c, q)).status).toBe(400);
    }
    expect(sdk.exchange).not.toHaveBeenCalled();
  });
  it('rejects expired login attempts before exchanging the code', async () => {
    const { cookie, state } = await login();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    try {
      expect((await callback(cookie, `code=code&state=${state}`)).status).toBe(400);
      expect(sdk.exchange).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it('exchanges the code with the matching verifier and provisions a local user', async () => {
    const { cookie, state, url } = await login();
    const res = await callback(cookie, `code=code&state=${state}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('wos-session=sealed-fixture;'))).toBe(true);
    const args = sdk.exchange.mock.calls[0][0];
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(args.codeVerifier));
    expect(Buffer.from(digest).toString('base64url')).toBe(url.searchParams.get('code_challenge'));
    const row = await env.DB.prepare('SELECT * FROM user WHERE workos_id = ?').bind(identity.id).first();
    expect(row?.email).toBe(identity.email);
    expect(row?.id).not.toBe(identity.id);
  });
  it('returns to the page the user was sent to sign in from', async () => {
    const { cookie, state } = await login('/conflicts/abc?x=1');
    const res = await callback(cookie, `code=code&state=${state}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/conflicts/abc?x=1');
  });
  it('never redirects off the app after sign-in, whatever returnTo says', async () => {
    const hostile = [
      '//evil.example/x', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'https://evil.example/',
      'javascript:alert(1)', 'conflicts/abc', '', '/%0a/evil.example\\x',
    ];
    for (const returnTo of hostile) {
      const { cookie, state } = await login(returnTo);
      const res = await callback(cookie, `code=code&state=${state}`);
      expect(res.headers.get('Location'), returnTo).toBe('/');
    }
  });
  it('keeps the return path when sending a login on another origin to the app origin', async () => {
    const res = await api.request(`http://elsewhere.test/login?returnTo=${encodeURIComponent('/conflicts/abc')}`, {}, env);
    expect(res.headers.get('Location')).toBe(`${origin}/login?returnTo=%2Fconflicts%2Fabc`);
  });
  it('shows a recoverable error instead of looping on rejected consent or exchange failure', async () => {
    const { cookie, state } = await login();
    const denied = await callback(cookie, `error=access_denied&state=${state}`);
    expect(denied.headers.get('Location')).toBe('/?authError=cancelled');
    sdk.exchange.mockRejectedValueOnce(new Error('provider failure'));
    const failed = await callback(cookie, `code=code&state=${state}`);
    expect(failed.headers.get('Location')).toBe('/?authError=callback');
  });
  it('returns no session when signed out and rejects protected Template access', async () => {
    expect(await (await sessionRequest('')).json()).toEqual({ user: null });
    sdk.authenticate.mockResolvedValue({ authenticated: false, reason: 'invalid_session_cookie' });
    await expect(client().template.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('refreshes expired tokens and attaches the rotated cookie to both session and RPC responses', async () => {
    sdk.authenticate.mockResolvedValue({ authenticated: false, reason: 'invalid_jwt' });
    sdk.refresh.mockResolvedValue({ authenticated: true, sealedSession: 'rotated', user: identity });
    const res = await sessionRequest();
    expect((await res.json()).user.email).toBe(identity.email);
    expect(res.headers.get('Set-Cookie')).toContain('wos-session=rotated;');
    const rpc = await api.request(`${origin}/rpc/session`, {
      method: 'POST', headers: { Origin: origin, Cookie: 'wos-session=old', 'Content-Type': 'application/json' }, body: '{}',
    }, env);
    expect(rpc.status).toBe(200);
    expect(rpc.headers.get('Set-Cookie')).toContain('wos-session=rotated;');
  });
  it('clears revoked sessions but preserves the cookie during transient refresh failures', async () => {
    sdk.authenticate.mockResolvedValue({ authenticated: false, reason: 'invalid_jwt' });
    sdk.refresh.mockResolvedValueOnce({ authenticated: false, retryable: false, reason: 'invalid_grant' });
    const revoked = await sessionRequest();
    expect(await revoked.json()).toEqual({ user: null });
    expect(revoked.headers.get('Set-Cookie')).toContain('Max-Age=0');
    sdk.refresh.mockResolvedValueOnce({ authenticated: false, retryable: true, reason: 'server_error' });
    const unavailable = await sessionRequest();
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Set-Cookie')).toBeNull();
  });
  it('requires same-origin POST for logout and Template writes', async () => {
    expect((await api.request(`${origin}/logout`, {}, env)).status).toBe(404);
    for (const route of ['/logout', '/rpc/template/put']) {
      expect((await api.request(`${origin}${route}`, { method: 'POST', headers: { Origin: 'https://evil.test' } }, env)).status).toBe(403);
      // A browser that leaves out Origin still sends its cookies, so it is refused too.
      expect((await api.request(`${origin}${route}`, { method: 'POST', headers: { Cookie: 'wos-session=sealed-fixture' } }, env)).status).toBe(403);
    }
    const res = await api.request(`${origin}/logout`, { method: 'POST', headers: { Origin: origin, Cookie: 'wos-session=sealed-fixture' } }, env);
    expect(res.status).toBe(303);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(sdk.logout).toHaveBeenCalledWith({ sessionId: 'session_fixture', returnTo: `${origin}/` });
  });
});

describe('Machine tokens and browser sessions', () => {
  async function machineToken() {
    const workos = fakeWorkOSDevice();
    try {
      const cli = rpcClient(env);
      const { deviceCode } = await cli.machines.deviceStart();
      workos.approve(deviceCode, identity);
      const result = await cli.machines.devicePoll({ deviceCode, name: 'laptop', os: 'linux', targets: [] });
      if (result.status !== 'approved') throw new Error(result.status);
      return result.token;
    } finally {
      workos.restore();
    }
  }

  it('authenticates a Machine token without refreshing a stale session cookie that came along', async () => {
    const token = await machineToken();
    sdk.authenticate.mockResolvedValue({ authenticated: false, reason: 'invalid_jwt' });
    sdk.refresh.mockResolvedValue({ authenticated: false, retryable: true, reason: 'server_error' });
    const both = rpcClient(env, { token, cookie: 'wos-session=expired' });
    expect(await both.template.get()).toMatchObject({ revision: 0 });
    expect(sdk.refresh).not.toHaveBeenCalled();
    // `session` still reports the browser session, so its refresh failure still shows.
    await expect(both.session()).rejects.toMatchObject({ status: 503 });
  });

  it('still answers `session` from the cookie when a Machine token is sent too', async () => {
    const token = await machineToken();
    expect(await rpcClient(env, { token, cookie: 'wos-session=sealed-fixture' }).session())
      .toMatchObject({ email: identity.email });
  });
});

describe('user migration and Template ownership', () => {
  async function legacy() {
    await env.DB.prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0)')
      .bind('legacy-user', 'Alice', identity.email).run();
  }
  it('links a verified WorkOS identity without changing the legacy user ID', async () => {
    await legacy();
    const user = await provisionUser(env, identity);
    expect(user.id).toBe('legacy-user');
    expect(await client().session()).toMatchObject({ id: 'legacy-user' });
    expect((await client().template.put({ text: 'Updated', expectedRevision: 0 })).revision).toBe(1);
  });
  it('does not claim a legacy email without verification or reassign an already linked identity', async () => {
    await legacy();
    await expect(provisionUser(env, { ...identity, emailVerified: false })).rejects.toThrow('cannot be linked');
    await provisionUser(env, identity);
    await expect(provisionUser(env, { ...identity, id: 'different-workos-user' })).rejects.toThrow('cannot be linked');
  });
  it('creates a local owner before the first Template save and isolates other users', async () => {
    expect((await client().template.put({ text: 'Private', expectedRevision: 0 })).revision).toBe(1);
    sdk.authenticate.mockResolvedValue({ authenticated: true, user: { ...identity, id: 'user_bob', email: 'bob@example.com' } });
    expect(await client().template.get()).toMatchObject({ text: '', revision: 0 });
  });
});
