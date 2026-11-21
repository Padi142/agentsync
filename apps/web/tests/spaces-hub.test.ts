import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { transformWithOxc } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { HUB_EXPIRES_AT_HEADER, HUB_SHARE_TOKEN_HEADER } from '../src/spaces/hub-protocol';

/**
 * The real `SpaceHub` in workerd. A small Worker in front of it forwards upgrades with the Share Link token
 * and expiry from the query string, where the app's Worker takes them from D1, and turns
 * `POST /rpc/<method>` into RPC calls. (The compatibility date is the newest the installed workerd knows.)
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
              headers.set('${HUB_SHARE_TOKEN_HEADER}', url.searchParams.get('token'));
              headers.set('${HUB_EXPIRES_AT_HEADER}', url.searchParams.get('expires') ?? 'never');
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
const upgradeStatus = async (space: string, token: string) =>
  (await mf.dispatchFetch(`http://hub.test/status?space=${space}&token=${token}`)).json();

/**
 * A viewer's socket (Node's own WebSocket client) with every message it got. `closed` resolves with the
 * reason once the hub has sent `closed` and started closing the socket. (Locally the TCP close itself
 * lags about ten seconds behind, so the close event is not waited for.)
 */
async function connect(space: string, token: string, expires = 'never') {
  const url = new URL(`ws?space=${space}&token=${token}&expires=${expires}`, (await mf.ready).href.replace(/^http/, 'ws'));
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

it('closes old-link sockets on rotation and refuses old-link upgrades after it', async () => {
  const old = await connect('rotating', 'old-token');
  await rpc('rotating', 'rotate', 'new-token');
  expect(await old.closed).toBe('rotated');
  expect(old.messages).toEqual([{ type: 'closed', reason: 'rotated' }]);

  expect(await upgradeStatus('rotating', 'old-token')).toBe(409);
  const fresh = await connect('rotating', 'new-token');
  await rpc('rotating', 'broadcast', { type: 'fileDeleted', path: 'a.txt' });
  await settle();
  expect(fresh.messages).toEqual([{ type: 'fileDeleted', path: 'a.txt' }]);
});

it('tells viewers when the Space expires, and moves the alarm when it is extended', async () => {
  const viewer = await connect('expiring', 'token', String(Date.now() + 300));
  await rpc('expiring', 'broadcast', { type: 'space', space: { status: 'active', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(viewer.messages.map((m) => (m as { type: string }).type)).toEqual(['space']);

  await rpc('expiring', 'broadcast', { type: 'space', space: { status: 'active', expiresAt: new Date(Date.now() + 200).toISOString() } });
  expect(await viewer.closed).toBe('expired');
  expect(viewer.messages.at(-1)).toEqual({ type: 'closed', reason: 'expired' });
});

it('forgets a deleted Space, so a new link may connect', async () => {
  const viewer = await connect('deleted', 'token');
  await rpc('deleted', 'close', 'deleted');
  expect(await viewer.closed).toBe('deleted');
  expect(await upgradeStatus('deleted', 'other-token')).toBe(101);
});
