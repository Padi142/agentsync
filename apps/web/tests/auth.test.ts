import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import type { AppRouter } from '../src/api/router';
import { provisionUser } from '../src/db/users';
import type { Env } from '../src/env';

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

const origin = 'http://app.test';
const env: Env = {
  DB: undefined as unknown as D1Database,
  WORKOS_API_KEY: 'sk_test_fixture',
  WORKOS_CLIENT_ID: 'client_fixture',
  WORKOS_COOKIE_PASSWORD: 'test-only-cookie-password-at-least-32-characters',
  WORKOS_REDIRECT_URI: `${origin}/callback`,
};
const identity = {
  id: 'user_workos_alice', email: 'alice@example.com', firstName: 'Alice', lastName: null,
  emailVerified: true, profilePictureUrl: null,
} as Parameters<typeof provisionUser>[1];
let mf: Miniflare;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'], });
  env.DB = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of ['0001_vengeful_cerise.sql', '0002_workos_users.sql']) {
    const sql = await readFile(new URL(`../drizzle/migrations/${name}`, import.meta.url), 'utf8');
    await env.DB.batch(sql.replaceAll('--> statement-breakpoint', '').split(';')
      .map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  }
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await env.DB.prepare('DELETE FROM file').run();
  await env.DB.prepare('DELETE FROM user').run();
  sdk.authenticate.mockResolvedValue({ authenticated: true, user: identity, sessionId: 'session_fixture' });
  sdk.exchange.mockResolvedValue({ user: identity, sealedSession: 'sealed-fixture' });
  sdk.logout.mockReturnValue('https://api.workos.com/user_management/sessions/logout');
});

async function login() {
  const res = await api.request(`${origin}/login`, {}, env);
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
function client() {
  return createORPCClient<RouterClient<AppRouter>>(new RPCLink({
    url: `${origin}/rpc`,
    fetch: (request) => api.fetch(new Request(request, {
      headers: new Headers([...request.headers, ['Origin', origin], ['Cookie', 'wos-session=sealed-fixture']]),
    }), env),
  }));
}

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
  it('shows a recoverable error instead of looping on rejected consent or exchange failure', async () => {
    const { cookie, state } = await login();
    const denied = await callback(cookie, `error=access_denied&state=${state}`);
    expect(denied.headers.get('Location')).toBe('/?authError=cancelled');
    sdk.exchange.mockRejectedValueOnce(new Error('provider failure'));
    const failed = await callback(cookie, `code=code&state=${state}`);
    expect(failed.headers.get('Location')).toBe('/?authError=callback');
  });
  it('returns no session when signed out and rejects protected file access', async () => {
    expect(await (await sessionRequest('')).json()).toEqual({ user: null });
    sdk.authenticate.mockResolvedValue({ authenticated: false, reason: 'invalid_session_cookie' });
    await expect(client().files.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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
  it('requires same-origin POST for logout and file writes', async () => {
    expect((await api.request(`${origin}/logout`, {}, env)).status).toBe(404);
    for (const route of ['/logout', '/rpc/files/create']) {
      expect((await api.request(`${origin}${route}`, { method: 'POST', headers: { Origin: 'https://evil.test' } }, env)).status).toBe(403);
    }
    const res = await api.request(`${origin}/logout`, { method: 'POST', headers: { Origin: origin, Cookie: 'wos-session=sealed-fixture' } }, env);
    expect(res.status).toBe(303);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(sdk.logout).toHaveBeenCalledWith({ sessionId: 'session_fixture', returnTo: `${origin}/` });
  });
});

describe('user migration and file ownership', () => {
  async function legacy() {
    await env.DB.prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0)')
      .bind('legacy-user', 'Alice', identity.email).run();
    await env.DB.prepare('INSERT INTO file (id, user_id, path, content, revision, updated_at) VALUES (?, ?, ?, ?, 1, 0)')
      .bind('legacy-file', 'legacy-user', 'AGENTS.md', 'Existing instructions').run();
  }
  it('links a verified WorkOS identity without changing legacy IDs or files', async () => {
    await legacy();
    const user = await provisionUser(env, identity);
    expect(user.id).toBe('legacy-user');
    expect((await client().files.list())[0].content).toBe('Existing instructions');
    const saved = await client().files.update({ id: 'legacy-file', path: 'AGENTS.md', content: 'Updated', expectedRevision: 1 });
    expect(saved.revision).toBe(2);
    await expect(client().files.update({ id: 'legacy-file', path: 'AGENTS.md', content: 'Stale', expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('does not claim a legacy email without verification or reassign an already linked identity', async () => {
    await legacy();
    await expect(provisionUser(env, { ...identity, emailVerified: false })).rejects.toThrow('cannot be linked');
    await provisionUser(env, identity);
    await expect(provisionUser(env, { ...identity, id: 'different-workos-user' })).rejects.toThrow('cannot be linked');
  });
  it('creates a local owner before file inserts and isolates other users', async () => {
    const created = await client().files.create({ path: 'AGENTS.md', content: 'Private' });
    expect(created.revision).toBe(1);
    sdk.authenticate.mockResolvedValue({ authenticated: true, user: { ...identity, id: 'user_bob', email: 'bob@example.com' } });
    expect(await client().files.list()).toEqual([]);
    await expect(client().files.update({ id: created.id, path: 'AGENTS.md', content: 'Stolen', expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
