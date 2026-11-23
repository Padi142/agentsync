import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPACE_LIMITS } from '@agentsync/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setup } from './harness.js';

afterEach(() => vi.unstubAllGlobals());

/** A registered Machine with a Space created from `files` (written under ~/src). */
async function withSpace(files: Record<string, string>) {
  const t = setup();
  t.registered();
  for (const [path, text] of Object.entries(files)) t.write(`src/${path}`, text);
  const created = await t.cli('space', 'create', t.path('src'), '--title', 'Report', '--json');
  expect(created.code).toBe(0);
  const { space, writeToken } = created.json() as { space: { id: string; shareUrl: string }; writeToken: string };
  return { t, id: space.id, url: space.shareUrl, token: writeToken, stored: () => t.server.state.spaces.get(space.id)! };
}

/** Every file under `dir`, as relative path → text. */
function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(at, entry.name), `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(join(at, entry.name), 'utf8');
    }
  };
  visit(dir, '');
  return files;
}

describe('space create, push and pull', () => {
  it('uploads a directory without junk or symlinks, and pulls it back with no account', async () => {
    const t = setup();
    t.registered();
    t.write('site/index.html', '<h1>Hi</h1>\n');
    t.write('site/css/style.css', 'h1 { color: red }\n');
    // Two files in one new folder: pull makes it from parallel downloads.
    t.write('site/css/print.css', 'p');
    t.write('site/..notes.md', 'n');
    t.write('site/.git/config', 'secret');
    t.write('site/node_modules/x/index.js', 'x');
    t.write('site/.DS_Store', 'x');
    symlinkSync(t.path('site/index.html'), t.path('site/link.html'));

    const created = await t.cli('space', 'create', t.path('site'), '--summary', 'A page');

    expect(created.code).toBe(0);
    const space = [...t.server.state.spaces.values()][0]!;
    expect(space.title).toBe('site');
    expect(Object.fromEntries([...space.files].map(([path, file]) => [path, file.contentType]))).toEqual({
      '..notes.md': 'text/markdown; charset=utf-8',
      'css/print.css': 'text/css; charset=utf-8',
      'css/style.css': 'text/css; charset=utf-8',
      'index.html': 'text/html; charset=utf-8',
    });
    const shareUrl = `${t.server.url}/s/${space.shareToken}`;
    expect(created.stdout).toContain(shareUrl);
    expect(created.stdout).toContain(space.writeToken);
    expect(created.stderr).toMatch(/shown only now.*AGENTSYNC_SPACE_TOKEN/s);

    // Readers need no config at all.
    rmSync(t.path('.config'), { recursive: true });
    const inspected = await t.cli('space', 'inspect', shareUrl, '--json');
    expect(inspected.json()).toMatchObject({ space: { title: 'site', summary: 'A page', status: 'active', files: expect.arrayContaining([{ path: '..notes.md' }, { path: 'css/print.css' }, { path: 'css/style.css' }, { path: 'index.html' }].map((file) => expect.objectContaining(file))) } });
    expect((await t.cli('space', 'get', shareUrl, 'index.html')).stdout).toBe('<h1>Hi</h1>\n');

    const pulled = await t.cli('space', 'pull', shareUrl, t.path('copy'), '--json');
    expect(pulled.code).toBe(0);
    expect(tree(t.path('copy'))).toEqual({ '..notes.md': 'n', 'css/print.css': 'p', 'index.html': '<h1>Hi</h1>\n', 'css/style.css': 'h1 { color: red }\n' });
    const again = await t.cli('space', 'pull', shareUrl, t.path('copy'), '--json');
    const { downloaded, unchanged } = again.json() as { downloaded: string[]; unchanged: string[] };
    expect({ downloaded, unchanged: unchanged.sort() }).toEqual({ downloaded: [], unchanged: ['..notes.md', 'css/print.css', 'css/style.css', 'index.html'] });
  });

  it('mirrors a directory with push: uploads only what changed and deletes what is gone, once confirmed', async () => {
    const { t, id, token, stored } = await withSpace({ 'a.txt': 'a', 'b.txt': 'b', 'sub/c.txt': 'c' });
    t.write('src/a.txt', 'a2');
    rmSync(t.path('src/b.txt'));
    t.write('src/d.txt', 'd');

    const refused = await t.cli('space', 'push', id, t.path('src'), '--token', token);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toContain('b.txt');
    expect([...stored().files.keys()].sort()).toEqual(['a.txt', 'b.txt', 'sub/c.txt']);

    t.server.state.spaceRequests.length = 0;
    const pushed = await t.cli('space', 'push', id, t.path('src'), '--token', token, '--yes', '--json');

    expect(pushed.code).toBe(0);
    expect(pushed.json()).toMatchObject({ uploaded: ['a.txt', 'd.txt'], deleted: ['b.txt'], unchanged: ['sub/c.txt'] });
    expect(t.server.state.spaceRequests.filter((request) => !request.startsWith('GET')).sort()).toEqual([
      `DELETE /api/spaces/${id}/files/b.txt`,
      `PUT /api/spaces/${id}/files/a.txt`,
      `PUT /api/spaces/${id}/files/d.txt`,
    ]);
    expect(Buffer.from(stored().files.get('a.txt')!.bytes).toString()).toBe('a2');
  });

  it('refuses a file over the size limit before creating anything', async () => {
    const t = setup();
    t.registered();
    mkdirSync(t.path('big'));
    // Sparse, so the test doesn't write 500 MB.
    writeFileSync(t.path('big/huge.bin'), '');
    truncateSync(t.path('big/huge.bin'), SPACE_LIMITS.fileBytes + 1);

    const result = await t.cli('space', 'create', t.path('big'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('at most 500.0 MB');
    expect(t.server.state.spaces.size).toBe(0);
  });

  it('uploads a file over a part\'s size in parts, sending a dropped part again', async () => {
    const { t, id, token, stored } = await withSpace({ 'a.txt': 'a' });
    const apk = Buffer.alloc(SPACE_LIMITS.partBytes + 5, 1).fill(2, SPACE_LIMITS.partBytes);
    writeFileSync(t.path('app.apk'), apk);
    t.server.state.spaceRequests.length = 0;
    t.server.state.dropParts = 1;

    const result = await t.cli('space', 'put', id, t.path('app.apk'), '--token', token);

    expect(result.code).toBe(0);
    const file = stored().files.get('app.apk')!;
    expect(Buffer.from(file.bytes).equals(apk)).toBe(true);
    expect(file.contentType).toBe('application/vnd.android.package-archive');
    expect(t.server.state.spaceRequests.map((request) => request.replace(/uploads\/[^/]+/, 'uploads/<id>'))).toEqual([
      `POST /api/spaces/${id}/uploads`,
      `PUT /api/spaces/${id}/uploads/<id>/parts/1`,
      `PUT /api/spaces/${id}/uploads/<id>/parts/2`,
      `POST /api/spaces/${id}/uploads/<id>/complete`,
    ]);
    expect(t.server.state.uploads.size).toBe(0);
  });
});

describe('the Write Token', () => {
  it('is never written to disk', async () => {
    const { t, id, token } = await withSpace({ 'a.txt': 'a' });
    t.write('b.txt', 'b');
    expect((await t.cli('space', 'put', id, t.path('b.txt'), 'docs/b.txt', '--token', token)).code).toBe(0);
    expect((await t.cli('space', 'update', id, '--title', 'New', '--token', token)).code).toBe(0);

    const files: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(dir, entry.name));
        else files.push(join(dir, entry.name));
      }
    };
    visit(t.home);
    expect(files.some((file) => file.includes('.config/agentsync'))).toBe(true);
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toContain(token);
  });

  it('is required, and a wrong one is an auth failure', async () => {
    const { t, id } = await withSpace({ 'a.txt': 'a' });

    expect((await t.cli('space', 'rm', id, 'a.txt')).code).toBe(5);
    const wrong = await t.cli('space', 'rm', id, 'a.txt', '--token', 'asw_wrong', '--json');
    expect(wrong.code).toBe(5);
    expect(wrong.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });
});

describe('space errors', () => {
  it('explains that an expired Space can be revived by its owner', async () => {
    const { t, id, url, token, stored } = await withSpace({ 'a.txt': 'a' });
    stored().expiresAt = new Date(Date.now() - 1000);
    t.write('b.txt', 'b');

    const put = await t.cli('space', 'put', id, t.path('b.txt'), '--token', token);
    expect(put.code).toBe(1);
    expect(put.stderr).toContain(`revive it at ${t.server.url}/spaces`);

    const read = await t.cli('space', 'inspect', url, '--json');
    expect(read.code).toBe(1);
    expect(read.json()).toMatchObject({ error: { code: 'SPACE_EXPIRED', message: expect.stringContaining('/spaces') } });
  });

  it('never writes outside the pull directory, whatever the server sends', async () => {
    const { t, url, stored } = await withSpace({ 'a.txt': 'a' });
    const file = stored().files.get('a.txt')!;
    stored().files.set('../escape.txt', file);

    const traversal = await t.cli('space', 'pull', url, t.path('out'));
    expect(traversal.code).toBe(1);
    expect(() => statSync(t.path('escape.txt'))).toThrow();

    // A symlink inside the directory can't carry a write out of it either.
    stored().files.delete('../escape.txt');
    stored().files.set('link/b.txt', file);
    mkdirSync(t.path('out'), { recursive: true });
    mkdirSync(t.path('elsewhere'));
    symlinkSync(t.path('elsewhere'), t.path('out/link'));
    const linked = await t.cli('space', 'pull', url, t.path('out'));
    expect(linked.code).toBe(1);
    expect(readdirSync(t.path('elsewhere'))).toEqual([]);
  });
});

describe('space pull --watch', () => {
  it('applies changes live, catches up after a reconnect, and stops when the Space is deleted', async () => {
    const { t, id, url, token, stored } = await withSpace({ 'a.txt': 'a', 'b.txt': 'b' });
    vi.stubGlobal('WebSocket', t.server.WebSocket);
    const out = t.path('out');
    const watching = t.cli('space', 'pull', url, out, '--watch', '--json');
    const open = () => t.server.state.sockets.filter((socket) => socket.open).length;
    await vi.waitFor(() => expect(open()).toBe(1));

    t.write('c.txt', 'c');
    await t.cli('space', 'put', id, t.path('c.txt'), '--token', token);
    await t.cli('space', 'rm', id, 'a.txt', '--token', token);
    t.server.broadcast(stored(), { type: 'file', file: { ...stored().files.get('c.txt')!, bytes: undefined, path: '../evil.txt' } });
    await vi.waitFor(() => expect(tree(out)).toEqual({ 'b.txt': 'b', 'c.txt': 'c' }));

    // Lost while the connection was down: the resync after reconnecting removes it.
    stored().files.delete('b.txt');
    t.server.dropSockets();
    await vi.waitFor(() => expect(tree(out)).toEqual({ 'c.txt': 'c' }));
    await vi.waitFor(() => expect(open()).toBe(1));

    await t.cli('space', 'delete', id, '--token', token, '--yes');
    const result = await watching;

    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ closed: 'deleted', removed: ['a.txt', 'b.txt'] });
    expect(result.stderr).toContain('the Space was deleted');
    expect(() => statSync(t.path('evil.txt'))).toThrow();
  });

  it('prunes empty parent directories when a nested file is deleted so a file can replace the folder name', async () => {
    const { t, id, url, token } = await withSpace({ 'foo/bar.txt': 'nested' });
    vi.stubGlobal('WebSocket', t.server.WebSocket);
    const out = t.path('out');
    const watching = t.cli('space', 'pull', url, out, '--watch', '--json');
    const open = () => t.server.state.sockets.filter((socket) => socket.open).length;
    await vi.waitFor(() => expect(open()).toBe(1));
    expect(tree(out)).toEqual({ 'foo/bar.txt': 'nested' });

    // Remove foo/bar.txt (pruning empty out/foo/), then upload a file literally named `foo`.
    expect((await t.cli('space', 'rm', id, 'foo/bar.txt', '--token', token)).code).toBe(0);
    await vi.waitFor(() => expect(() => statSync(join(out, 'foo'))).toThrow());
    // Root pull directory stays intact.
    expect(statSync(out).isDirectory()).toBe(true);

    t.write('foo', 'now a file');
    expect((await t.cli('space', 'put', id, t.path('foo'), 'foo', '--token', token)).code).toBe(0);
    await vi.waitFor(() => expect(tree(out)).toEqual({ foo: 'now a file' }));

    await t.cli('space', 'delete', id, '--token', token, '--yes');
    expect((await watching).code).toBe(0);
  });
});

describe('space file count limit', () => {
  it('fails fast before creating a Space when a directory exceeds SPACE_LIMITS.maxFiles', async () => {
    const t = setup();
    t.registered();
    const dir = t.path('many');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i <= SPACE_LIMITS.maxFiles; i++) writeFileSync(join(dir, `f-${i}.txt`), '');

    const result = await t.cli('space', 'create', dir, '--title', 'Too Many', '--json');
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({ ok: false, error: { code: 'SPACE_FULL' } });
    expect(t.server.state.spaces.size).toBe(0);
  });
});
