import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractClient, SpaceEvent } from '@agentsync/contract';
import { vi } from 'vitest';
import { api } from '../src/api';
import type { Env } from '../src/env';
import { HUB_STALE_STATUS, HUB_STATE_HEADER, type HubCloseReason, type HubState } from '../src/spaces/hub-protocol';

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
    SPACES_BUCKET: withBufferedParts((await mf.getR2Bucket('SPACES_BUCKET')) as unknown as R2Bucket),
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

/**
 * Miniflare's R2 wants a part body of known length. In the Workers runtime a request's own body has one;
 * in Node it doesn't, so streamed parts are read into memory here first.
 */
function withBufferedParts(bucket: R2Bucket): R2Bucket {
  const bound = <T extends object>(target: T, property: string | symbol) => {
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  return new Proxy(bucket, { get(target, property) {
    if (property !== 'resumeMultipartUpload') return bound(target, property);
    return (key: string, uploadId: string) => new Proxy(target.resumeMultipartUpload(key, uploadId), { get(upload, name) {
      if (name !== 'uploadPart') return bound(upload, name);
      return async (partNumber: number, value: Parameters<R2MultipartUpload['uploadPart']>[1]) =>
        upload.uploadPart(partNumber, value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : value);
    } });
  } });
}

/** `crypto.DigestStream`, which the Workers runtime has and Node doesn't: a WritableStream that hashes what it is sent. */
class DigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = createHash(algorithm.replace('-', '').toLowerCase());
    let done!: (digest: ArrayBuffer) => void;
    const digest = new Promise<ArrayBuffer>((resolve) => { done = resolve; });
    super({
      write: (chunk) => void hash.update(ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk)),
      close: () => done(new Uint8Array(hash.digest()).buffer),
    });
    this.digest = digest;
  }
}
if (!('DigestStream' in crypto)) Object.defineProperty(crypto, 'DigestStream', { value: DigestStream });

/** Delete every row, children first. */
export async function resetDb(env: Env) {
  for (const table of [
    'space_file', 'space', 'skill_request', 'skill_folder_version', 'skill_exclusion', 'skill_settings', 'machine_skill_report', 'skill_pin_move', 'skill_machine', 'skill',
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
 * A fake `SPACE_HUB` namespace: records the events the Worker sends each Space's `SpaceHub` (`close`,
 * and a sync to a new token, are recorded as the `closed` event they send) and the upgrades it accepts.
 * Like the real hub it keeps the newest `HubState` per Space and refuses, with `HUB_STALE_STATUS`, an
 * upgrade carrying older state or arriving after a close. `beforeUpgrade` runs before each upgrade is
 * answered, to stage races. Set `failing` to make every call throw, like a Durable Object outage.
 */
export function fakeSpaceHub() {
  const fake = {
    events: [] as { spaceId: string; event: SpaceEvent }[],
    upgrades: [] as { spaceId: string; state: HubState }[],
    states: new Map<string, HubState & { closed: HubCloseReason | null }>(),
    failing: false,
    beforeUpgrade: undefined as (() => Promise<void>) | undefined,
    namespace: undefined as unknown as Env['SPACE_HUB'],
    /** The events sent to one Space, in order. */
    eventsOf: (spaceId: string) => fake.events.filter((e) => e.spaceId === spaceId).map((e) => e.event),
    reset() {
      fake.events.length = 0;
      fake.upgrades.length = 0;
      fake.states.clear();
      fake.failing = false;
      fake.beforeUpgrade = undefined;
    },
  };
  const stub = (spaceId: string) => {
    const call = async <T>(work: () => T | Promise<T>) => {
      if (fake.failing) throw new Error('SpaceHub is down');
      return work();
    };
    const apply = (incoming: HubState) => {
      const stored = fake.states.get(spaceId);
      if (stored && (stored.closed === 'deleted' || incoming.version < stored.version ||
          (incoming.version === stored.version && (stored.closed || stored.token !== incoming.token)))) return stored;
      if (stored && stored.token !== incoming.token) fake.events.push({ spaceId, event: { type: 'closed', reason: 'rotated' } });
      const next = { ...incoming, closed: null };
      fake.states.set(spaceId, next);
      return next;
    };
    return {
      broadcast: (event: SpaceEvent, state: HubState) => call(() => {
        if (!apply(state).closed) fake.events.push({ spaceId, event });
      }),
      sync: (state: HubState) => call(() => { apply(state); }),
      close: (reason: HubCloseReason, version: number) => call(() => {
        fake.events.push({ spaceId, event: { type: 'closed', reason } });
        const stored = fake.states.get(spaceId);
        fake.states.set(spaceId, { token: stored?.token ?? '', expiresAt: null, version: Math.max(version, stored?.version ?? 0), closed: reason });
      }),
      fetch: (request: Request) => call(async () => {
        await fake.beforeUpgrade?.();
        const incoming = JSON.parse(request.headers.get(HUB_STATE_HEADER)!) as HubState;
        const state = apply(incoming);
        if (state.closed || state.token !== incoming.token || state.version !== incoming.version) {
          return new Response('stale', { status: HUB_STALE_STATUS });
        }
        fake.upgrades.push({ spaceId, state: incoming });
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
