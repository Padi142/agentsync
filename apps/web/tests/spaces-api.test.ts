import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SPACE_LIMITS, SPACE_OWNER_ROUTES, SPACE_PUBLIC_ROUTES, SPACE_WRITER_ROUTES, parseShareUrl, type CreatedSpace } from '@agentsync/contract';
import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { hashSecret } from '../src/db/machines';
import { deleteSpaceRow, getSpaceByWriteToken } from '../src/db/spaces';
import type { Env } from '../src/env';
import { spacesRoute } from '../src/spaces/routing';
import { spacesService } from '../src/spaces/service';
import { createTestEnv, fakeSpaceHub, fakeWorkOSDevice, origin, resetDb, rpcClient } from './helpers';

const identities = {
  alice: { id: 'user_alice', email: 'alice@example.com', firstName: 'Alice', lastName: null, emailVerified: true, profilePictureUrl: null },
  bob: { id: 'user_bob', email: 'bob@example.com', firstName: 'Bob', lastName: null, emailVerified: true, profilePictureUrl: null },
};
vi.mock('@workos-inc/node', async (importOriginal) => {
  const { WorkOS } = await importOriginal<typeof import('@workos-inc/node')>();
  return { WorkOS: class extends WorkOS {
    constructor(...args: ConstructorParameters<typeof WorkOS>) {
      super(...args);
      this.userManagement.loadSealedSession = (({ sessionData }: { sessionData: string }) => ({
        authenticate: async () => {
          const user = Object.values(identities).find((identity) => identity.id === sessionData);
          return user ? { authenticated: true, user, sessionId: `session_${user.id}` } : { authenticated: false, reason: 'invalid_session_cookie' };
        },
      })) as never;
    }
  } };
});

type Who = keyof typeof identities;
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

let mf: Miniflare;
let env: Env;
let hub: ReturnType<typeof fakeSpaceHub>;
let workos: ReturnType<typeof fakeWorkOSDevice>;

beforeAll(async () => {
  ({ mf, env, hub } = await createTestEnv());
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await resetDb(env);
  await clearBucket();
  hub.reset();
  workos?.restore();
  workos = fakeWorkOSDevice();
});

async function clearBucket() {
  const { objects } = await env.SPACES_BUCKET.list();
  if (objects.length) await env.SPACES_BUCKET.delete(objects.map((o) => o.key));
}
const objectKeys = async (prefix: string) => (await env.SPACES_BUCKET.list({ prefix })).objects.map((o) => o.key);

const browser = (who: Who = 'alice') => rpcClient(env, { cookie: `wos-session=${identities[who].id}` });

async function machine(who: Who = 'alice') {
  const cli = rpcClient(env);
  const { deviceCode } = await cli.machines.deviceStart();
  workos.approve(deviceCode, identities[who]);
  const result = await cli.machines.devicePoll({ deviceCode, nickname: 'laptop', hostname: 'laptop', os: 'linux', targets: [{ path: '~/.claude/CLAUDE.md', agent: 'claude' }] });
  if (result.status !== 'approved') throw new Error(result.status);
  return { token: result.token, client: rpcClient(env, { token: result.token }) };
}

async function createSpace(who: Who = 'alice', title = 'Report'): Promise<CreatedSpace & { shareToken: string; machineToken: string }> {
  const { client, token } = await machine(who);
  const created = await client.spaces.create({ title });
  return { ...created, shareToken: parseShareUrl(created.space.shareUrl)!.shareToken, machineToken: token };
}

/** A request to the API as the CLI makes it: no Origin, no cookies. */
function call(method: string, path: string, init: { token?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  return api.fetch(new Request(`${origin}${path}`, { method, headers, body: init.body ?? null, duplex: 'half' } as RequestInit), env);
}
const put = (spaceId: string, path: string, token: string, body: BodyInit, headers: Record<string, string> = {}) =>
  call('PUT', SPACE_WRITER_ROUTES.file(spaceId, path), { token, body, headers });
const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;
const setExpiresAt = (spaceId: string, at: number | null) =>
  env.DB.prepare('UPDATE space SET expires_at = ? WHERE id = ?').bind(at, spaceId).run();

describe('who may act on a Space', () => {
  it('lets a Machine create a Space but not list, read, change or write existing ones', async () => {
    const { space, machineToken } = await createSpace();
    const cli = rpcClient(env, { token: machineToken });
    await expect(cli.spaces.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(cli.spaces.get({ spaceId: space.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(cli.spaces.update({ spaceId: space.id, private: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(cli.spaces.delete({ spaceId: space.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    for (const response of [
      await call('GET', SPACE_WRITER_ROUTES.space(space.id), { token: machineToken }),
      await put(space.id, 'a.txt', machineToken, 'hi'),
      await call('DELETE', SPACE_WRITER_ROUTES.space(space.id), { token: machineToken }),
    ]) {
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('UNAUTHORIZED');
    }
    expect((await browser().spaces.get({ spaceId: space.id })).id).toBe(space.id);
  });

  it("keeps a Write Token to its own Space", async () => {
    const a = await createSpace('alice', 'A');
    const b = await createSpace('alice', 'B');
    expect((await put(b.space.id, 'b.txt', b.writeToken, 'mine')).status).toBe(200);
    for (const response of [
      await call('GET', SPACE_WRITER_ROUTES.space(b.space.id), { token: a.writeToken }),
      await call('PATCH', SPACE_WRITER_ROUTES.space(b.space.id), { token: a.writeToken, body: JSON.stringify({ title: 'pwned' }) }),
      await put(b.space.id, 'b.txt', a.writeToken, 'theirs'),
      await call('DELETE', SPACE_WRITER_ROUTES.file(b.space.id, 'b.txt'), { token: a.writeToken }),
      await call('DELETE', SPACE_WRITER_ROUTES.space(b.space.id), { token: a.writeToken }),
      await call('GET', SPACE_WRITER_ROUTES.space('no-such-space'), { token: a.writeToken }),
    ]) {
      // Like a wrong token: nothing tells whether Space B exists.
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('UNAUTHORIZED');
    }
    const raw = await call('GET', SPACE_PUBLIC_ROUTES.raw(b.shareToken, 'b.txt'));
    expect(await raw.text()).toBe('mine');
  });

  it('stores only a hash of the Write Token', async () => {
    const { space, writeToken } = await createSpace();
    expect(writeToken).toMatch(/^asw_[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare('SELECT * FROM space WHERE id = ?').bind(space.id).first<Record<string, unknown>>();
    expect(row!.write_token_hash).toBe(await hashSecret(writeToken));
    expect(JSON.stringify(row)).not.toContain(writeToken.slice(4));
  });

  it('refuses Write Token mutations that carry browser cookies', async () => {
    const { space, writeToken } = await createSpace();
    const cookie = `wos-session=${identities.alice.id}`;
    expect((await put(space.id, 'a.txt', writeToken, 'hi', { Cookie: cookie })).status).toBe(403);
    // Even from the app's own origin: the dashboard never uses these routes.
    expect((await put(space.id, 'a.txt', writeToken, 'hi', { Cookie: cookie, Origin: origin })).status).toBe(401);
    expect(await objectKeys(`${space.id}/`)).toEqual([]);
  });

  it("scopes the dashboard to the signed-in user's Spaces", async () => {
    const { space, writeToken } = await createSpace('alice');
    await put(space.id, 'a.txt', writeToken, 'hi');
    await expect(browser('bob').spaces.get({ spaceId: space.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(browser('bob').spaces.deleteFile({ spaceId: space.id, path: 'a.txt' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(browser('bob').spaces.delete({ spaceId: space.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await browser('bob').spaces.list()).spaces).toEqual([]);
    expect((await browser('alice').spaces.get({ spaceId: space.id })).files.map((f) => f.path)).toEqual(['a.txt']);
  });
});

describe('files', () => {
  it('uploads, serves and replaces a file, keeping R2, D1 and viewers in step', async () => {
    const { space, writeToken, shareToken } = await createSpace();
    const first = await put(space.id, 'docs/notes.md', writeToken, '# Notes\n', { 'Content-Type': 'text/markdown' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ path: 'docs/notes.md', size: 8, contentType: 'text/markdown; charset=utf-8' });
    const replaced = await put(space.id, 'docs/notes.md', writeToken, '# Notes, longer\n');
    expect(await replaced.json()).toMatchObject({ size: 16, contentType: 'text/markdown; charset=utf-8' });
    expect(await objectKeys(`${space.id}/`)).toHaveLength(1);

    const raw = await call('GET', SPACE_PUBLIC_ROUTES.raw(shareToken, 'docs/notes.md'));
    expect(await raw.text()).toBe('# Notes, longer\n');
    const { spaces, usedBytes } = await browser().spaces.list();
    expect(spaces[0]).toMatchObject({ totalBytes: 16, fileCount: 1 });
    expect(usedBytes).toBe(16);
    expect(hub.eventsOf(space.id).map((e) => e.type === 'file' && e.file.size)).toEqual([8, 16]);

    expect((await call('DELETE', SPACE_WRITER_ROUTES.file(space.id, 'docs/notes.md'), { token: writeToken })).status).toBe(204);
    expect(await objectKeys(`${space.id}/`)).toEqual([]);
    expect((await browser().spaces.list()).usedBytes).toBe(0);
    expect(hub.eventsOf(space.id).at(-1)).toEqual({ type: 'fileDeleted', path: 'docs/notes.md' });
    expect((await call('DELETE', SPACE_WRITER_ROUTES.file(space.id, 'docs/notes.md'), { token: writeToken })).status).toBe(404);
  });

  it('stores the SHA-256 it computes, and rejects an upload whose X-Content-SHA256 differs', async () => {
    const { space, writeToken } = await createSpace();
    const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(await (await put(space.id, 'a.txt', writeToken, 'abc')).json()).toMatchObject({ sha256: abc });
    const wrong = await put(space.id, 'b.txt', writeToken, 'abd', { 'X-Content-SHA256': abc });
    expect(wrong.status).toBe(400);
    expect(await errorCode(wrong)).toBe('INVALID_REQUEST');
    expect((await browser().spaces.get({ spaceId: space.id })).files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('still writes when the SpaceHub is down', async () => {
    const { space, writeToken } = await createSpace();
    hub.failing = true;
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    expect((await put(space.id, 'a.txt', writeToken, 'hi')).status).toBe(200);
  });

  it('rejects paths that are not already normalized, on upload and on raw fetch', async () => {
    const { space, writeToken, shareToken } = await createSpace();
    await put(space.id, 'secret.txt', writeToken, 'secret');
    for (const encoded of [
      '..%2Fsecret.txt', 'a%2F..%2Fb', '%2e%2e%2fsecret.txt', 'a%00b', '%2Fetc%2Fpasswd', '%5Cetc%5Cpasswd',
      'a%5C..%5Cb', 'a//b', 'C%3A%5Cx', '', '%E0%A4%A',
    ]) {
      const upload = await call('PUT', `/api/spaces/${space.id}/files/${encoded}`, { token: writeToken, body: 'x' });
      expect([encoded, upload.status, await errorCode(upload)]).toEqual([encoded, 422, 'INVALID_PATH']);
      expect([encoded, (await call('GET', `/s/${shareToken}/raw/${encoded}`)).status]).toEqual([encoded, 422]);
    }
    expect((await browser().spaces.get({ spaceId: space.id })).files.map((f) => f.path)).toEqual(['secret.txt']);
  });

  it('never reaches a file through dot segments the URL parser resolves', async () => {
    const { space, writeToken, shareToken } = await createSpace();
    for (const path of ['../x', '%2e%2e/x', '.%2e/x']) {
      expect((await call('PUT', `/api/spaces/${space.id}/files/${path}`, { token: writeToken, body: 'x' })).ok).toBe(false);
      expect((await call('GET', `/s/${shareToken}/raw/${path}`)).ok).toBe(false);
    }
    expect(await objectKeys(`${space.id}/`)).toEqual([]);
  });

  it('serves raw HTML and SVG as sandboxed attachments, and images inline, to any origin', async () => {
    const { space, writeToken, shareToken } = await createSpace();
    await put(space.id, 'index.html', writeToken, '<script>alert(1)</script>');
    await put(space.id, 'logo.svg', writeToken, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await put(space.id, 'page', writeToken, '<script>alert(1)</script>', { 'Content-Type': 'text/html' });
    await put(space.id, 'fake.png', writeToken, '<script>alert(1)</script>', { 'Content-Type': 'text/html' });
    await put(space.id, 'pixel.png', writeToken, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    for (const path of ['index.html', 'logo.svg', 'page']) {
      const response = await call('GET', SPACE_PUBLIC_ROUTES.raw(shareToken, path));
      expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename*=UTF-8''${path}`);
      expect(response.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
    // A known extension wins over the declared type, and nosniff keeps the browser to it.
    expect((await call('GET', SPACE_PUBLIC_ROUTES.raw(shareToken, 'fake.png'))).headers.get('Content-Type')).toBe('image/png');
    const image = await call('GET', SPACE_PUBLIC_ROUTES.raw(shareToken, 'pixel.png'));
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(image.headers.get('Content-Disposition')).toBeNull();
    expect(image.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(image.headers.get('Set-Cookie')).toBeNull();
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe('storage limits', () => {
  it('rejects a file over 25 MB from its Content-Length, and while reading a body without one', async () => {
    const { space, writeToken } = await createSpace();
    const declared = await put(space.id, 'big.bin', writeToken, 'small', { 'Content-Length': String(SPACE_LIMITS.fileBytes + 1) });
    expect(declared.status).toBe(413);
    expect(await errorCode(declared)).toBe('FILE_TOO_LARGE');

    const chunk = new Uint8Array(MB);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const streamed = await put(space.id, 'big.bin', writeToken, endless);
    expect(streamed.status).toBe(413);
    expect(await errorCode(streamed)).toBe('FILE_TOO_LARGE');
    expect(sent).toBeLessThan(SPACE_LIMITS.fileBytes + 4 * MB);
    expect(await objectKeys(`${space.id}/`)).toEqual([]);
  });

  it('keeps a Space under 100 MB, counting the size of the file being replaced', async () => {
    const { space, writeToken } = await createSpace();
    await put(space.id, 'a.txt', writeToken, '1234567890');
    // Pretend the Space already holds 100 MB but 5 bytes, 10 of them `a.txt`.
    await env.DB.prepare('UPDATE space SET total_bytes = ? WHERE id = ?').bind(SPACE_LIMITS.spaceBytes - 5, space.id).run();
    const full = await put(space.id, 'b.txt', writeToken, '123456');
    expect(full.status).toBe(413);
    expect(await errorCode(full)).toBe('SPACE_FULL');
    expect((await put(space.id, 'b.txt', writeToken, '12345')).status).toBe(200);
    expect((await put(space.id, 'a.txt', writeToken, '1234567890')).status).toBe(200);
    expect(await errorCode(await put(space.id, 'a.txt', writeToken, '12345678901'))).toBe('SPACE_FULL');
    expect(await objectKeys(`${space.id}/`)).toHaveLength(2);
  });

  it('keeps a user under 500 MB across Spaces, and stops creating Spaces at the limit', async () => {
    const big = await createSpace('alice', 'Big');
    const { space, writeToken } = await createSpace('alice', 'Small');
    await env.DB.prepare('UPDATE space SET total_bytes = ? WHERE id = ?').bind(SPACE_LIMITS.userBytes - 3, big.space.id).run();
    const over = await put(space.id, 'a.txt', writeToken, '1234');
    expect(over.status).toBe(413);
    expect(await errorCode(over)).toBe('QUOTA_EXCEEDED');
    expect((await put(space.id, 'a.txt', writeToken, '123')).status).toBe(200);
    expect(await browser().spaces.list()).toMatchObject({ usedBytes: SPACE_LIMITS.userBytes, limitBytes: SPACE_LIMITS.userBytes });
    const { client } = await machine('alice');
    await expect(client.spaces.create({ title: 'One more' })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 413 });
    // Bob's quota is his own.
    expect((await createSpace('bob')).space.title).toBe('Report');
  });

  it('stops creating Spaces at 200 per user', async () => {
    const { client } = await machine('alice');
    await client.spaces.create({ title: 'First' });
    const [{ user_id: userId }] = (await env.DB.prepare('SELECT user_id FROM space').all<{ user_id: string }>()).results;
    await env.DB.batch(Array.from({ length: 199 }, (_, i) => env.DB.prepare(
      `INSERT INTO space (id, user_id, title, share_token, write_token_hash, is_private, total_bytes, created_at, updated_at)
       VALUES (?1, ?2, 'x', ?1, ?1, 0, 0, 0, 0)`,
    ).bind(`filler-${i}`, userId)));
    await expect(client.spaces.create({ title: 'One more' })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
});

describe('lifecycle', () => {
  it('rejects Write Token mutations once expired, and accepts them again after a revive at the same link', async () => {
    const { space, writeToken, shareToken } = await createSpace();
    await put(space.id, 'a.txt', writeToken, 'hi');
    await setExpiresAt(space.id, Date.now() - 1000);

    for (const response of [
      await put(space.id, 'b.txt', writeToken, 'hi'),
      await call('PATCH', SPACE_WRITER_ROUTES.space(space.id), { token: writeToken, body: JSON.stringify({ expires: 'never' }) }),
      await call('DELETE', SPACE_WRITER_ROUTES.file(space.id, 'a.txt'), { token: writeToken }),
      await call('DELETE', SPACE_WRITER_ROUTES.space(space.id), { token: writeToken }),
    ]) {
      expect(response.status).toBe(410);
      expect(await errorCode(response)).toBe('SPACE_EXPIRED');
    }
    const read = await call('GET', SPACE_WRITER_ROUTES.space(space.id), { token: writeToken });
    expect(await read.json()).toMatchObject({ status: 'expired' });
    expect((await call('GET', SPACE_PUBLIC_ROUTES.json(shareToken))).status).toBe(410);
    expect((await call('GET', SPACE_PUBLIC_ROUTES.raw(shareToken, 'a.txt'))).status).toBe(410);

    const revived = await browser().spaces.update({ spaceId: space.id, expires: '7d' });
    expect(revived).toMatchObject({ status: 'active', shareUrl: space.shareUrl });
    expect((await put(space.id, 'b.txt', writeToken, 'back')).status).toBe(200);
    expect((await call('GET', SPACE_PUBLIC_ROUTES.raw(shareToken, 'b.txt'))).status).toBe(200);
  });

  it('lets the writer rename and extend its Space', async () => {
    const { space, writeToken } = await createSpace();
    const response = await call('PATCH', SPACE_WRITER_ROUTES.space(space.id), {
      token: writeToken, body: JSON.stringify({ title: 'Renamed', summary: 'Why', expires: 'never' }),
    });
    expect(await response.json()).toMatchObject({ title: 'Renamed', summary: 'Why', expiresAt: null, status: 'active' });
    expect(hub.eventsOf(space.id)).toEqual([{ type: 'space', space: expect.objectContaining({ title: 'Renamed' }) }]);
    const invalid = await call('PATCH', SPACE_WRITER_ROUTES.space(space.id), { token: writeToken, body: JSON.stringify({ expires: '9999d' }) });
    expect(await errorCode(invalid)).toBe('INVALID_REQUEST');
  });

  it('hides a private Space from its Share Link but keeps it writable', async () => {
    const { space, writeToken, shareToken } = await createSpace();
    await put(space.id, 'a.txt', writeToken, 'hi');
    await browser().spaces.update({ spaceId: space.id, private: true });
    expect(hub.eventsOf(space.id).at(-1)).toEqual({ type: 'closed', reason: 'private' });
    for (const path of [
      SPACE_PUBLIC_ROUTES.space(shareToken), SPACE_PUBLIC_ROUTES.json(shareToken), SPACE_PUBLIC_ROUTES.markdown(shareToken),
      SPACE_PUBLIC_ROUTES.raw(shareToken, 'a.txt'), SPACE_PUBLIC_ROUTES.zip(shareToken), SPACE_PUBLIC_ROUTES.ws(shareToken),
    ]) {
      const response = await call('GET', path, { headers: { Upgrade: 'websocket' } });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('NOT_FOUND');
    }
    expect(hub.upgrades).toEqual([]);
    expect((await put(space.id, 'b.txt', writeToken, 'still')).status).toBe(200);
    expect((await browser().spaces.get({ spaceId: space.id })).status).toBe('private');
  });

  it('turns the old Share Link off when it is rotated', async () => {
    const { space, shareToken } = await createSpace();
    await call('GET', SPACE_PUBLIC_ROUTES.ws(shareToken), { headers: { Upgrade: 'websocket' } });
    const rotated = await browser().spaces.rotateLink({ spaceId: space.id });
    const fresh = parseShareUrl(rotated.shareUrl)!.shareToken;
    expect(fresh).not.toBe(shareToken);
    expect((await call('GET', SPACE_PUBLIC_ROUTES.json(shareToken))).status).toBe(404);
    expect((await call('GET', SPACE_PUBLIC_ROUTES.json(fresh))).status).toBe(200);
    expect(hub.eventsOf(space.id)).toEqual([{ type: 'closed', reason: 'rotated' }]);
  });

  it('deletes a Space with its files, from the dashboard or with the Write Token', async () => {
    const a = await createSpace('alice', 'A');
    const b = await createSpace('alice', 'B');
    await put(a.space.id, 'a.txt', a.writeToken, 'a');
    await put(b.space.id, 'b.txt', b.writeToken, 'b');
    await browser().spaces.delete({ spaceId: a.space.id });
    expect((await call('DELETE', SPACE_WRITER_ROUTES.space(b.space.id), { token: b.writeToken })).status).toBe(204);
    expect(await objectKeys('')).toEqual([]);
    expect((await browser().spaces.list()).spaces).toEqual([]);
    expect(hub.eventsOf(a.space.id).at(-1)).toEqual({ type: 'closed', reason: 'deleted' });
    expect((await call('GET', SPACE_PUBLIC_ROUTES.json(a.shareToken))).status).toBe(404);
  });

  it('purges Spaces 30 days after they expire, never private or permanent ones', async () => {
    const now = Date.now();
    const spaces = { due: await createSpace(), grace: await createSpace(), private: await createSpace(), permanent: await createSpace() };
    for (const { space, writeToken } of Object.values(spaces)) await put(space.id, 'a.txt', writeToken, 'a');
    await setExpiresAt(spaces.due.space.id, now - (SPACE_LIMITS.graceDays + 1) * DAY_MS);
    await setExpiresAt(spaces.grace.space.id, now - (SPACE_LIMITS.graceDays - 1) * DAY_MS);
    await setExpiresAt(spaces.private.space.id, now - 365 * DAY_MS);
    await env.DB.prepare('UPDATE space SET is_private = 1 WHERE id = ?').bind(spaces.private.space.id).run();
    await setExpiresAt(spaces.permanent.space.id, null);

    expect(await spacesService(env).purge(new Date(now), 10)).toBe(1);
    expect(await objectKeys(`${spaces.due.space.id}/`)).toEqual([]);
    const left = (await browser().spaces.list()).spaces.map((s) => s.id).sort();
    expect(left).toEqual([spaces.grace.space.id, spaces.private.space.id, spaces.permanent.space.id].sort());
    expect(hub.eventsOf(spaces.due.space.id).at(-1)).toEqual({ type: 'closed', reason: 'deleted' });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM space_file').first('n')).toBe(3);
  });

  it('purges only a Space still due when its row is deleted', async () => {
    const { space } = await createSpace();
    const cutoff = new Date(Date.now() - SPACE_LIMITS.graceDays * DAY_MS);
    await setExpiresAt(space.id, Date.now() + DAY_MS); // Revived after the purge picked it.
    expect(await deleteSpaceRow(env, space.id, { expiredBefore: cutoff })).toBe(false);
    await setExpiresAt(space.id, cutoff.getTime() - 1);
    expect(await deleteSpaceRow(env, space.id, { expiredBefore: cutoff })).toBe(true);
  });

  it('leaves no R2 object behind when a Space is deleted during an upload', async () => {
    const { space, writeToken } = await createSpace();
    const racing: Env = { ...env, SPACES_BUCKET: new Proxy(env.SPACES_BUCKET, { get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== 'put' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: Parameters<R2Bucket['put']>) => {
        const written = await target.put(...args);
        await browser().spaces.delete({ spaceId: space.id });
        return written;
      };
    } }) };
    const request = new Request(`${origin}${SPACE_WRITER_ROUTES.file(space.id, 'a.txt')}`, {
      method: 'PUT', body: 'late', headers: { Authorization: `Bearer ${writeToken}` },
    });
    expect((await api.fetch(request, racing)).status).toBe(404);
    expect(await objectKeys(`${space.id}/`)).toEqual([]);
  });
});

describe('public Share Link routes', () => {
  it('answers JSON and Markdown by suffix or Accept, without credentials', async () => {
    const { space, writeToken, shareToken } = await createSpace();
    await put(space.id, 'README.md', writeToken, '# Hello\n');
    const json = await call('GET', SPACE_PUBLIC_ROUTES.space(shareToken), { headers: { Accept: 'application/json' } });
    expect(await json.json()).toMatchObject({ id: space.id, files: [{ path: 'README.md' }] });
    const markdown = await call('GET', SPACE_PUBLIC_ROUTES.markdown(shareToken));
    expect(markdown.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await markdown.text()).toContain('# Hello');
    expect(await (await call('GET', SPACE_PUBLIC_ROUTES.space(shareToken))).text()).toMatch(/^# Report\n/);
    expect((await call('GET', SPACE_PUBLIC_ROUTES.json('A'.repeat(32)))).status).toBe(404);
    const slash = await call('GET', `${SPACE_PUBLIC_ROUTES.space(shareToken)}/`, { headers: { Accept: 'application/json' } });
    expect(await slash.json()).toMatchObject({ id: space.id });
    const preferred = await call('GET', SPACE_PUBLIC_ROUTES.space(shareToken), { headers: { Accept: 'text/markdown;q=0.5, application/json' } });
    expect(preferred.headers.get('Content-Type')).toBe('application/json');
  });

  it('forwards a WebSocket upgrade to the hub of an active Space only, with the token it checked', async () => {
    const { space, shareToken } = await createSpace();
    expect((await call('GET', SPACE_PUBLIC_ROUTES.ws(shareToken))).status).toBe(400);
    const upgraded = await call('GET', SPACE_PUBLIC_ROUTES.ws(shareToken), {
      headers: { Upgrade: 'websocket', 'X-AgentSync-Hub-State': JSON.stringify({ token: 'forged', expiresAt: null, version: 9e15 }) },
    });
    expect(await upgraded.text()).toBe('upgraded by the fake SpaceHub');
    expect(hub.upgrades).toEqual([{
      spaceId: space.id, state: { token: shareToken, expiresAt: space.expiresAt!.getTime(), version: space.updatedAt.getTime() },
    }]);
    await setExpiresAt(space.id, Date.now() - 1000);
    expect((await call('GET', SPACE_PUBLIC_ROUTES.ws(shareToken), { headers: { Upgrade: 'websocket' } })).status).toBe(410);
  });

  it('refuses an upgrade checked just before the link was rotated', async () => {
    const { space, shareToken } = await createSpace();
    hub.beforeUpgrade = async () => {
      hub.beforeUpgrade = undefined;
      await browser().spaces.rotateLink({ spaceId: space.id });
    };
    const response = await call('GET', SPACE_PUBLIC_ROUTES.ws(shareToken), { headers: { Upgrade: 'websocket' } });
    expect(response.status).toBe(404);
    expect(hub.upgrades).toEqual([]);
  });

  it('refuses an upgrade checked just before the Space was made private or deleted', async () => {
    for (const change of ['private', 'deleted'] as const) {
      const { space, shareToken } = await createSpace();
      hub.beforeUpgrade = async () => {
        hub.beforeUpgrade = undefined;
        if (change === 'private') await browser().spaces.update({ spaceId: space.id, private: true });
        else await browser().spaces.delete({ spaceId: space.id });
      };
      const response = await call('GET', SPACE_PUBLIC_ROUTES.ws(shareToken), { headers: { Upgrade: 'websocket' } });
      expect([change, response.status]).toEqual([change, 404]);
    }
    expect(hub.upgrades).toEqual([]);
  });

  it('catches up a hub that missed a rotation', async () => {
    const { space, shareToken } = await createSpace();
    await call('GET', SPACE_PUBLIC_ROUTES.ws(shareToken), { headers: { Upgrade: 'websocket' } });
    hub.failing = true;
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    const fresh = parseShareUrl((await browser().spaces.rotateLink({ spaceId: space.id })).shareUrl)!.shareToken;
    hub.failing = false;
    const response = await call('GET', SPACE_PUBLIC_ROUTES.ws(fresh), { headers: { Upgrade: 'websocket' } });
    expect(await response.text()).toBe('upgraded by the fake SpaceHub');
    expect(hub.states.get(space.id)?.token).toBe(fresh);
    expect(hub.eventsOf(space.id)).toEqual([{ type: 'closed', reason: 'rotated' }]);
  });

  it('streams a ZIP of every file that unzips to the same bytes', async () => {
    const { space, writeToken, shareToken } = await createSpace();
    const files: Record<string, Uint8Array<ArrayBuffer>> = {
      'index.html': new TextEncoder().encode('<h1>Hi</h1>'),
      'assets/data.bin': Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7919) % 251),
      'notes/čeština.md': new TextEncoder().encode('Ahoj\n'),
      'empty.txt': new Uint8Array(),
    };
    for (const [path, bytes] of Object.entries(files)) await put(space.id, path, writeToken, bytes);
    const response = await call('GET', SPACE_PUBLIC_ROUTES.zip(shareToken));
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    const dir = await mkdtemp(join(tmpdir(), 'agentsync-zip-'));
    try {
      const zipPath = join(dir, 'space.zip');
      await writeFile(zipPath, new Uint8Array(await response.arrayBuffer()));
      // Python's zipfile checks every CRC-32 as it reads.
      const { stdout } = await promisify(execFile)('python3', ['-I', '-c', [
        'import sys, zipfile, json, hashlib',
        'z = zipfile.ZipFile(sys.argv[1])',
        'assert z.testzip() is None',
        'print(json.dumps({i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}))',
      ].join('\n'), zipPath]);
      const expected = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path, bytes]) => [path,
        Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')])));
      expect(JSON.parse(stdout)).toEqual(expected);
      const { stdout: listing } = await promisify(execFile)('unzip', ['-l', zipPath]);
      expect(listing).toContain('4 files');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('failures part way through', () => {
  it('deletes the new R2 object when recording the upload fails', async () => {
    const { space, writeToken } = await createSpace();
    const broken: Env = { ...env, DB: new Proxy(env.DB, { get(target, property) {
      if (property === 'batch') return () => Promise.reject(new Error('D1 is down'));
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = new Request(`${origin}${SPACE_WRITER_ROUTES.file(space.id, 'a.txt')}`, {
      method: 'PUT', body: 'hi', headers: { Authorization: `Bearer ${writeToken}` },
    });
    expect((await api.fetch(request, broken)).status).toBe(500);
    expect(await objectKeys(`${space.id}/`)).toEqual([]);
  });

  it('still removes the file and tells viewers when its R2 object cannot be deleted', async () => {
    const { space, writeToken } = await createSpace();
    await put(space.id, 'a.txt', writeToken, 'hi');
    const flaky: Env = { ...env, SPACES_BUCKET: new Proxy(env.SPACES_BUCKET, { get(target, property) {
      if (property === 'delete') return () => Promise.reject(new Error('R2 is down'));
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    const request = new Request(`${origin}${SPACE_WRITER_ROUTES.file(space.id, 'a.txt')}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${writeToken}` },
    });
    expect((await api.fetch(request, flaky)).status).toBe(204);
    expect(hub.eventsOf(space.id).at(-1)).toEqual({ type: 'fileDeleted', path: 'a.txt' });
  });

  it('keeps an extension made while a rename was in flight', async () => {
    const { space, writeToken } = await createSpace();
    const stale = (await getSpaceByWriteToken(env, writeToken))!;
    await browser().spaces.update({ spaceId: space.id, expires: 'never' });
    const renamed = await spacesService(env).update(stale, { title: 'Renamed' });
    expect(renamed).toMatchObject({ title: 'Renamed', expiresAt: null });
  });
});

describe('owner raw and zip routes', () => {
  const ownerCookie = (who: Who = 'alice') => ({ Cookie: `wos-session=${identities[who].id}` });

  it('routes /api/owner/spaces/* to the API', () => {
    expect(spacesRoute('/api/owner/spaces/s1/raw/index.html', 'text/html')).toBe('api');
    expect(spacesRoute('/api/owner/spaces/s1/download.zip', 'text/html')).toBe('api');
  });

  it('lets the signed-in owner read raw files and ZIP for active, private, and expired Spaces with hardened headers', async () => {
    const { space, writeToken, machineToken } = await createSpace('alice', 'Quarterly Report');
    expect((await put(space.id, 'index.html', writeToken, '<h1>Secret</h1>')).status).toBe(200);
    expect((await put(space.id, 'notes/readme.txt', writeToken, 'hello')).status).toBe(200);

    for (const state of ['active', 'private', 'expired'] as const) {
      if (state === 'private') await browser('alice').spaces.update({ spaceId: space.id, private: true });
      if (state === 'expired') {
        await browser('alice').spaces.update({ spaceId: space.id, private: false });
        await setExpiresAt(space.id, Date.now() - DAY_MS);
      }
      const html = await call('GET', SPACE_OWNER_ROUTES.raw(space.id, 'index.html'), { headers: ownerCookie('alice') });
      expect([state, html.status]).toEqual([state, 200]);
      expect(await html.text()).toBe('<h1>Secret</h1>');
      expect(html.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
      expect(html.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(html.headers.get('Content-Disposition')).toContain('attachment');
      expect(html.headers.get('Cache-Control')).toBe('private, no-store');
      expect(html.headers.get('Access-Control-Allow-Origin')).toBeNull();

      const txt = await call('GET', SPACE_OWNER_ROUTES.raw(space.id, 'notes/readme.txt'), { headers: ownerCookie('alice') });
      expect(txt.status).toBe(200);
      expect(await txt.text()).toBe('hello');
      expect(txt.headers.get('Content-Disposition')).toBeNull();

      const zip = await call('GET', SPACE_OWNER_ROUTES.zip(space.id), { headers: ownerCookie('alice') });
      expect([state, zip.status]).toEqual([state, 200]);
      expect(zip.headers.get('Content-Type')).toBe('application/zip');
      expect(zip.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect((await zip.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }

    // Another user gets 404; unauthenticated, Machine token, and Write Token all get 401 (even alongside cookies).
    expect((await call('GET', SPACE_OWNER_ROUTES.raw(space.id, 'index.html'), { headers: ownerCookie('bob') })).status).toBe(404);
    expect((await call('GET', SPACE_OWNER_ROUTES.zip(space.id), { headers: ownerCookie('bob') })).status).toBe(404);
    expect((await call('GET', SPACE_OWNER_ROUTES.raw(space.id, 'index.html'))).status).toBe(401);
    expect((await call('GET', SPACE_OWNER_ROUTES.raw(space.id, 'index.html'), { token: machineToken })).status).toBe(401);
    expect((await call('GET', SPACE_OWNER_ROUTES.raw(space.id, 'index.html'), { token: writeToken })).status).toBe(401);
    expect((await call('GET', SPACE_OWNER_ROUTES.raw(space.id, 'index.html'), { token: machineToken, headers: ownerCookie('alice') })).status).toBe(401);
  });
});

describe('file count limit and path-prefix collisions', () => {
  it('enforces SPACE_LIMITS.maxFiles on new paths while allowing overwrites at the limit', async () => {
    const { space, writeToken } = await createSpace();
    const now = Date.now();
    const sha = '0'.repeat(64);
    // Seed maxFiles rows in one SQL statement so the test runs in milliseconds.
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n + 1 < ?2)
       INSERT INTO space_file (space_id, path, size, content_type, sha256, r2_key, updated_at)
       SELECT ?1, 'f-' || n || '.txt', 0, 'text/plain; charset=utf-8', ?3, ?1 || '/seed-' || n, ?4 FROM seq`,
    ).bind(space.id, SPACE_LIMITS.maxFiles, sha, now).run();

    const over = await put(space.id, 'one-too-many.txt', writeToken, 'nope');
    expect(over.status).toBe(413);
    expect(await errorCode(over)).toBe('SPACE_FULL');
    expect(await objectKeys(`${space.id}/`)).toEqual([]);

    // Replacing an existing file at maxFiles still succeeds.
    const replace = await put(space.id, 'f-0.txt', writeToken, 'updated');
    expect(replace.status).toBe(200);
    expect(await objectKeys(`${space.id}/`)).toHaveLength(1);
  });

  it('rejects ancestor/descendant path collisions without LIKE wildcard false positives and leaves no orphan blobs', async () => {
    const { space, writeToken } = await createSpace();
    expect((await put(space.id, 'a', writeToken, 'file')).status).toBe(200);

    // Ancestor conflict: a already exists as a file, so a/b and a/b/c must fail.
    for (const blocked of ['a/b', 'a/b/c']) {
      const res = await put(space.id, blocked, writeToken, 'nested');
      expect([blocked, res.status]).toEqual([blocked, 422]);
      expect(await errorCode(res)).toBe('INVALID_PATH');
    }

    // Sibling names that share a string prefix (not a directory boundary) must succeed.
    expect((await put(space.id, 'ab/c', writeToken, 'ok')).status).toBe(200);
    expect((await put(space.id, 'a_b', writeToken, 'ok')).status).toBe(200);

    // Descendant conflict: ab/c exists, so ab must fail.
    const descendant = await put(space.id, 'ab', writeToken, 'file');
    expect(descendant.status).toBe(422);
    expect(await errorCode(descendant)).toBe('INVALID_PATH');

    // Wildcard characters % and _ must be treated literally.
    expect((await put(space.id, 'a%', writeToken, 'pct')).status).toBe(200);
    expect((await put(space.id, 'a_x', writeToken, 'under')).status).toBe(200);
    const pctChild = await put(space.id, 'a%/child', writeToken, 'bad');
    expect(pctChild.status).toBe(422);
    expect(await errorCode(pctChild)).toBe('INVALID_PATH');

    // After deleting `a`, `a/b` can be created.
    expect((await call('DELETE', SPACE_WRITER_ROUTES.file(space.id, 'a'), { token: writeToken })).status).toBe(204);
    expect((await put(space.id, 'a/b', writeToken, 'now ok')).status).toBe(200);

    // Exactly the 5 live files should exist in R2 (no leaked orphans from rejected uploads).
    expect(await objectKeys(`${space.id}/`)).toHaveLength(5);
  });
});
