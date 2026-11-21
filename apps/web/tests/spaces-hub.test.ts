import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { transformWithOxc } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { HUB_STATE_HEADER, type HubState } from '../src/spaces/hub-protocol';

/**
 * The real `SpaceHub` in workerd. A small Worker in front of it forwards upgrades with the `HubState` from
 * the query string, where the app's Worker takes it from D1, and turns `POST /rpc/<method>` into RPC calls.
 * (The compatibility date is the newest the installed workerd knows.)
 */
let mf: Miniflare;

async function compile(file: string) {
  const source = await readFile(new URL(`../src/spaces/${file}.ts`, import.meta.url), 'utf8');
  return (await transformWithOxc(source, `${file}.ts`)).code.replace(/from ['"]\.\/hub-protocol['"]/g, "from './hub-protocol.js'");
}

beforeAll(async () => {
  mf = new Miniflare({
    compatibilityDate: '2026-08-01',
    modules: [
      { type: 'ESModule', path: 'worker.js', contents: `
        export { SpaceHub } from './hub.js';
        export default {
          async fetch(request, env) {
            const url = new URL(request.url);
            const hub = env.HUB.get(env.HUB.idFromName(url.searchParams.get('space')));
            if (url.pathname === '/ws' || url.pathname === '/status') {
              const headers = new Headers(request.headers);
              headers.set('Upgrade', 'websocket');
              headers.set('${HUB_STATE_HEADER}', url.searchParams.get('state'));
              const response = await hub.fetch(new Request(request, { headers }));
              if (url.pathname === '/ws') return response;
              // Only the status, for an upgrade the hub is expected to refuse.
              response.webSocket?.accept();
              response.webSocket?.close(1000);
              return Response.json(response.status);
            }
            const args = await request.json();
            return Response.json((await hub[url.pathname.slice('/rpc/'.length)](...args)) ?? null);
          },
        };` },
      { type: 'ESModule', path: 'hub.js', contents: await compile('hub') },
      { type: 'ESModule', path: 'hub-protocol.js', contents: await compile('hub-protocol') },
    ],
    durableObjects: { HUB: 'SpaceHub' },
  });
});
afterAll(async () => { await mf?.dispose(); });

/** The status the hub answers an upgrade with, for one it is expected to refuse. */
const upgradeStatus = async (space: string, state: HubState) =>
  (await mf.dispatchFetch(`http://hub.test/status?space=${space}&state=${encodeURIComponent(JSON.stringify(state))}`)).json();

/**
 * A viewer's socket (Node's own WebSocket client) with every message it got. `closed` resolves with the
 * reason once the hub has sent `closed` and started closing the socket. (Locally the TCP close itself
 * lags about ten seconds behind, so the close event is not waited for.)
 */
async function connect(space: string, state: HubState) {
  const query = `space=${space}&state=${encodeURIComponent(JSON.stringify(state))}`;
  const url = new URL(`ws?${query}`, (await mf.ready).href.replace(/^http/, 'ws'));
  const socket = new WebSocket(url);
  const messages: unknown[] = [];
  let close: (reason: string) => void;
  const closed = new Promise<string>((resolve) => { close = resolve; });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { type: string; reason?: string };
    messages.push(message);
    if (message.type === 'closed') {
      const poll = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) return;
        clearInterval(poll);
        close(message.reason!);
      }, 10);
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  return { messages, closed };
}

const rpc = (space: string, method: string, ...args: unknown[]) =>
  mf.dispatchFetch(`http://hub.test/rpc/${method}?space=${space}`, { method: 'POST', body: JSON.stringify(args) });
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const state = (token: string, version: number, expiresAt: number | null = null): HubState => ({ token, version, expiresAt });
const event = { type: 'fileDeleted', path: 'a.txt' } as const;

it('moves to a new Share Link on newer state, and refuses upgrades with older state', async () => {
  const old = await connect('rotating', state('old', 1));
  // A rotation the hub missed: the next broadcast carries the new token.
  await rpc('rotating', 'broadcast', event, state('new', 2));
  expect(await old.closed).toBe('rotated');
  expect(old.messages).toEqual([{ type: 'closed', reason: 'rotated' }]);

  expect(await upgradeStatus('rotating', state('old', 1))).toBe(409);
  const fresh = await connect('rotating', state('new', 2));
  await rpc('rotating', 'broadcast', event, state('old', 1)); // Stale state: ignored, the event still goes out.
  await settle();
  expect(fresh.messages).toEqual([event]);
});

it('tells viewers when the Space expires, and a stale upgrade cannot bring back an old expiry', async () => {
  const viewer = await connect('expiring', state('t', 1, Date.now() + 300));
  await rpc('expiring', 'broadcast', event, state('t', 2, null)); // Made permanent.
  expect(await upgradeStatus('expiring', state('t', 1, Date.now() + 300))).toBe(409);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(viewer.messages).toEqual([event]);

  await rpc('expiring', 'sync', state('t', 3, Date.now() + 200));
  expect(await viewer.closed).toBe('expired');
  expect(viewer.messages.at(-1)).toEqual({ type: 'closed', reason: 'expired' });
  expect(await upgradeStatus('expiring', state('t', 3, Date.now() - 1))).toBe(409);
});

it('refuses upgrades once the Space is made private, until newer state reopens it', async () => {
  const viewer = await connect('private', state('t', 1));
  await rpc('private', 'close', 'private', 2);
  expect(await viewer.closed).toBe('private');
  expect(await upgradeStatus('private', state('t', 1))).toBe(409);
  expect(await upgradeStatus('private', state('t', 2))).toBe(409);
  expect(await upgradeStatus('private', state('t', 3))).toBe(101);
});

it('refuses every upgrade once the Space is deleted', async () => {
  const viewer = await connect('deleted', state('t', 1));
  await rpc('deleted', 'close', 'deleted', 2);
  expect(await viewer.closed).toBe('deleted');
  expect(await upgradeStatus('deleted', state('t', 99))).toBe(409);
});
