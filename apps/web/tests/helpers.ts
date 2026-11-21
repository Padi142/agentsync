import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractClient, SpaceEvent } from '@agentsync/contract';
import { vi } from 'vitest';
import { api } from '../src/api';
import type { Env } from '../src/env';
import {
  HUB_EXPIRES_AT_HEADER, HUB_SHARE_TOKEN_HEADER, HUB_STALE_TOKEN_STATUS, type HubCloseReason,
} from '../src/spaces/hub-protocol';

export const origin = 'http://app.test';

/** A Miniflare D1 database with every migration applied and an R2 bucket for Spaces, plus WorkOS fixture settings. */
export async function createTestEnv() {
  const hub = fakeSpaceHub();
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    r2Buckets: ['SPACES_BUCKET'],
  });
  const env: Env = {
    DB: (await mf.getD1Database('DB')) as unknown as D1Database,
    SPACES_BUCKET: (await mf.getR2Bucket('SPACES_BUCKET')) as unknown as R2Bucket,
    SPACE_HUB: hub.namespace,
    WORKOS_API_KEY: 'sk_test_fixture',
    WORKOS_CLIENT_ID: 'client_fixture',
    WORKOS_COOKIE_PASSWORD: 'test-only-cookie-password-at-least-32-characters',
    WORKOS_REDIRECT_URI: `${origin}/callback`,
  };
  const migrations = new URL('../drizzle/migrations/', import.meta.url);
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', migrations), 'utf8'));
  for (const { tag } of journal.entries as { tag: string }[]) {
    const sql = await readFile(new URL(`${tag}.sql`, migrations), 'utf8');
    await env.DB.batch(sql.split('--> statement-breakpoint')
      .map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  }
  return { mf, env, hub };
}

/** Delete every row, children first. */
export async function resetDb(env: Env) {
  for (const table of [
    'space_file', 'space', 'skill_folder_version', 'skill_exclusion', 'skill_settings', 'machine_skill_report', 'skill_pin_move', 'skill_machine', 'skill',
    'device_authorization', 'conflict', 'machine_variables_revision', 'machine_variables',
    'machine_credential', 'machine', 'template_revision', 'template', 'user',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

/**
 * A typed client for `/rpc`. Pass `cookie` to act as a signed-in browser (with its
 * Origin header) or `token` to act as a Machine (no Origin, like the CLI).
 */
export function rpcClient(env: Env, auth: { cookie?: string; token?: string } = {}) {
  return createORPCClient<ContractClient>(new RPCLink({
    url: `${origin}/rpc`,
    fetch: (request) => {
      const headers = new Headers(request.headers);
      if (auth.cookie) {
        headers.set('Cookie', auth.cookie);
        headers.set('Origin', origin);
      }
      if (auth.token) headers.set('Authorization', `Bearer ${auth.token}`);
      return api.fetch(new Request(request, { headers }), env);
    },
  }));
}

type DeviceState = 'authorization_pending' | 'access_denied' | 'expired_token' | { user: Record<string, unknown> };

/**
 * A fake of the WorkOS CLI Auth device endpoints behind `fetch`. Other requests pass through.
 * Unlike WorkOS, an approved code keeps answering with the user, so the server's own
 * single-use check is what keeps registration single-use.
 */
export function fakeWorkOSDevice() {
  const codes = new Map<string, DeviceState>();
  const slowDowns = new Map<string, number>();
  const polls: URLSearchParams[] = [];
  let issued = 0;
  const realFetch = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://api.workos.com/')) return realFetch(input, init);
    const body = new URLSearchParams(String(init?.body));
    if (url === 'https://api.workos.com/user_management/authorize/device') {
      if (body.get('client_id') !== 'client_fixture') return json({ error: 'invalid_client' }, 400);
      const deviceCode = `device_${++issued}`;
      codes.set(deviceCode, 'authorization_pending');
      return json({
        device_code: deviceCode,
        user_code: `CODE-${issued}`,
        verification_uri: 'https://auth.example.com/device',
        verification_uri_complete: `https://auth.example.com/device?user_code=CODE-${issued}`,
        expires_in: 300,
        interval: 5,
      });
    }
    if (url === 'https://api.workos.com/user_management/authenticate') {
      polls.push(body);
      const state = codes.get(body.get('device_code') ?? '');
      if (body.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code' ||
          body.get('client_id') !== 'client_fixture' || !state) {
        return json({ error: 'invalid_grant' }, 400);
      }
      const slow = slowDowns.get(body.get('device_code')!) ?? 0;
      if (slow > 0) {
        slowDowns.set(body.get('device_code')!, slow - 1);
        return json({ error: 'slow_down', error_description: 'slow_down' }, 400);
      }
      if (typeof state === 'object') {
        return json({ user: state.user, access_token: 'workos-access', refresh_token: 'workos-refresh' });
      }
      return json({ error: state, error_description: state }, 400);
    }
    return json({ error: 'not_found' }, 404);
  });
  return {
    polls,
    set(deviceCode: string, state: DeviceState) { codes.set(deviceCode, state); },
    /** Answer the next `times` polls for this code with `slow_down`. */
    slowDown(deviceCode: string, times = 1) { slowDowns.set(deviceCode, times); },
    approve(deviceCode: string, identity: { id: string; email: string; firstName: string | null }) {
      codes.set(deviceCode, { user: {
        object: 'user', id: identity.id, email: identity.email, first_name: identity.firstName,
        last_name: null, email_verified: true, profile_picture_url: null,
      } });
    },
    restore() { spy.mockRestore(); },
  };
}

/**
 * A fake `SPACE_HUB` namespace: records the events the Worker sends each Space's `SpaceHub`
 * (`close` and `rotate` are recorded as the `closed` event they send) and the upgrades it accepts.
 * Like the real hub, it remembers each Space's Share Link token and refuses upgrades for another
 * with `HUB_STALE_TOKEN_STATUS`. `beforeUpgrade` runs before each upgrade is answered, to stage races.
 * Set `failing` to make every call throw, like a Durable Object outage.
 */
export function fakeSpaceHub() {
  const fake = {
    events: [] as { spaceId: string; event: SpaceEvent }[],
    upgrades: [] as { spaceId: string; token: string | null; expiresAt: string | null }[],
    tokens: new Map<string, string>(),
    failing: false,
    beforeUpgrade: undefined as (() => Promise<void>) | undefined,
    namespace: undefined as unknown as Env['SPACE_HUB'],
    /** The events sent to one Space, in order. */
    eventsOf: (spaceId: string) => fake.events.filter((e) => e.spaceId === spaceId).map((e) => e.event),
    reset() {
      fake.events.length = 0;
      fake.upgrades.length = 0;
      fake.tokens.clear();
      fake.failing = false;
      fake.beforeUpgrade = undefined;
    },
  };
  const stub = (spaceId: string) => {
    const call = async <T>(work: () => T | Promise<T>) => {
      if (fake.failing) throw new Error('SpaceHub is down');
      return work();
    };
    const closed = (reason: HubCloseReason) => fake.events.push({ spaceId, event: { type: 'closed', reason } });
    return {
      broadcast: (event: SpaceEvent) => call(() => { fake.events.push({ spaceId, event }); }),
      close: (reason: HubCloseReason) => call(() => {
        closed(reason);
        if (reason === 'deleted') fake.tokens.delete(spaceId);
      }),
      rotate: (token: string) => call(() => {
        fake.tokens.set(spaceId, token);
        closed('rotated');
      }),
      fetch: (request: Request) => call(async () => {
        await fake.beforeUpgrade?.();
        const token = request.headers.get(HUB_SHARE_TOKEN_HEADER);
        const current = fake.tokens.get(spaceId);
        if (current && current !== token) return new Response('stale', { status: HUB_STALE_TOKEN_STATUS });
        if (token) fake.tokens.set(spaceId, token);
        fake.upgrades.push({ spaceId, token, expiresAt: request.headers.get(HUB_EXPIRES_AT_HEADER) });
        return new Response('upgraded by the fake SpaceHub');
      }),
    };
  };
  fake.namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => stub(id.name),
  } as unknown as Env['SPACE_HUB'];
  return fake;
}
