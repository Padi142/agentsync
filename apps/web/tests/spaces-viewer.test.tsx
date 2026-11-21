// @vitest-environment jsdom
import type { PublicSpace, SpaceFile } from '@agentsync/contract';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTree, defaultFile, fileKind, pickFile, resolveSpacePath, withBaseHref,
} from '../src/components/spaces/files';
import { liveReducer, useLiveSpace, type Loaded } from '../src/components/spaces/live';

const TOKEN = 'a'.repeat(32);

const file = (path: string, sha = '0', size = 10): SpaceFile => ({
  path, size, contentType: 'text/plain', sha256: sha.padEnd(64, '0'), updatedAt: new Date('2026-11-01T00:00:00Z'),
});

const space = (files: SpaceFile[]): PublicSpace => ({
  id: 'space-1', title: 'Report', summary: null, status: 'active', expiresAt: null,
  shareUrl: `https://agentsync.test/s/${TOKEN}`, totalBytes: files.reduce((sum, f) => sum + f.size, 0), files,
  createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-01T00:00:00Z'),
});

describe('withBaseHref', () => {
  it('puts the base first in an existing head, keeping its attributes', () => {
    expect(withBaseHref('<!doctype html><html><head lang="en"><title>x</title></head></html>', 'https://h/raw/'))
      .toBe('<!doctype html><html><head lang="en"><base href="https://h/raw/"><title>x</title></head></html>');
  });

  it('adds a head after <html> or the doctype, never before the doctype, and not into <header>', () => {
    expect(withBaseHref('<html><body><header>x</header></body></html>', 'u'))
      .toBe('<html><head><base href="u"></head><body><header>x</header></body></html>');
    expect(withBaseHref('<!DOCTYPE html><p>hi</p>', 'u')).toBe('<!DOCTYPE html><head><base href="u"></head><p>hi</p>');
    expect(withBaseHref('<p>hi</p>', 'u')).toBe('<head><base href="u"></head><p>hi</p>');
  });

  it('escapes the URL so it cannot break out of the attribute', () => {
    expect(withBaseHref('<head></head>', 'https://h/a"><script>x</script>&'))
      .toBe('<head><base href="https://h/a&quot;&gt;&lt;script&gt;x&lt;/script&gt;&amp;"></head>');
  });
});

describe('resolveSpacePath', () => {
  it('resolves relative URLs against the file’s folder, decoding segments and keeping the hash', () => {
    expect(resolveSpacePath('img/a%20b.png?x=1', 'docs')).toEqual({ path: 'docs/img/a b.png', hash: '' });
    expect(resolveSpacePath('../README.md#setup', 'docs/guide')).toEqual({ path: 'docs/README.md', hash: '#setup' });
    expect(resolveSpacePath('./b.md', '')).toEqual({ path: 'b.md', hash: '' });
    expect(resolveSpacePath('/assets/logo.svg', 'deep/down')).toEqual({ path: 'assets/logo.svg', hash: '' });
  });

  it('leaves URLs that point outside the Space alone', () => {
    for (const url of ['https://x.test/a.png', 'mailto:a@b.c', '//cdn.test/x.js', '#top', '../../etc/passwd', 'data:image/png;base64,AA']) {
      expect(resolveSpacePath(url, 'docs')).toBeNull();
    }
  });
});

describe('which file opens', () => {
  it('prefers index.html, then the only root page, then README.md, then the first file', () => {
    expect(defaultFile([file('a.txt'), file('index.html'), file('README.md')])?.path).toBe('index.html');
    expect(defaultFile([file('a.txt'), file('report.md'), file('docs/x.html')])?.path).toBe('report.md');
    expect(defaultFile([file('a.md'), file('README.md')])?.path).toBe('README.md');
    expect(defaultFile([file('b.txt'), file('c.txt')])?.path).toBe('b.txt');
  });

  it('falls back to the default and names the missing path when the asked-for file is gone', () => {
    const files = [file('index.html'), file('notes.md')];
    expect(pickFile(files, 'notes.md')).toEqual({ file: files[1], missing: null });
    expect(pickFile(files, 'gone.md')).toEqual({ file: files[0], missing: 'gone.md' });
  });
});

it('nests files by folder, folders first', () => {
  const tree = buildTree([file('z.md'), file('docs/b.md'), file('docs/img/x.png'), file('a.md')]);
  expect(tree.map((n) => n.path)).toEqual(['docs', 'a.md', 'z.md']);
  const docs = tree[0]!;
  expect(docs.kind === 'folder' && docs.children.map((n) => n.path)).toEqual(['docs/img', 'docs/b.md']);
});

it('renders by kind, and downloads text too big to show', () => {
  expect(fileKind({ path: 'a/README.md', contentType: 'application/octet-stream', size: 1 })).toBe('markdown');
  expect(fileKind({ path: 'index.htm', contentType: 'text/html', size: 1 })).toBe('html');
  expect(fileKind({ path: 'logo.svg', contentType: 'image/svg+xml', size: 1 })).toBe('image');
  expect(fileKind({ path: 'data.json', contentType: 'application/json', size: 1 })).toBe('text');
  expect(fileKind({ path: 'main.rs', contentType: 'application/octet-stream', size: 1 })).toBe('text');
  expect(fileKind({ path: 'huge.log', contentType: 'text/plain', size: 50 * 1024 * 1024 })).toBe('binary');
  expect(fileKind({ path: 'report.pdf', contentType: 'application/pdf', size: 1 })).toBe('binary');
});

describe('liveReducer', () => {
  const loaded = (files: SpaceFile[]): Loaded => ({ kind: 'space', space: space(files) });

  it('adds and replaces files in path order, and keeps the total size current', () => {
    let state = liveReducer(loaded([file('b.md', '1', 10)]), { type: 'event', event: { type: 'file', file: file('a.md', '2', 5) } });
    state = liveReducer(state, { type: 'event', event: { type: 'file', file: file('b.md', '3', 20) } });
    expect(state.kind === 'space' && state.space.files.map((f) => [f.path, f.sha256[0]])).toEqual([['a.md', '2'], ['b.md', '3']]);
    expect(state.kind === 'space' && state.space.totalBytes).toBe(25);
  });

  it('drops deleted files and merges new metadata without losing files', () => {
    let state = liveReducer(loaded([file('a.md'), file('b.md')]), { type: 'event', event: { type: 'fileDeleted', path: 'a.md' } });
    const { files: _, ...meta } = space([]);
    state = liveReducer(state, { type: 'event', event: { type: 'space', space: { ...meta, title: 'Renamed' } } });
    expect(state.kind === 'space' && [state.space.title, state.space.files.map((f) => f.path)]).toEqual(['Renamed', ['b.md']]);
  });

  it('becomes unavailable when the link closes, telling expired apart from the rest', () => {
    const closed = (reason: 'deleted' | 'private' | 'expired' | 'rotated') =>
      liveReducer(loaded([]), { type: 'event', event: { type: 'closed', reason } });
    expect(closed('expired')).toEqual({ kind: 'unavailable', reason: 'expired' });
    for (const reason of ['deleted', 'private', 'rotated'] as const) expect(closed(reason)).toEqual({ kind: 'unavailable', reason: 'missing' });
  });
});

/** A WebSocket the test drives by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  send(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  drop() { this.onclose?.(); }
}

describe('useLiveSpace', () => {
  const fetchSpace = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', fetchSpace);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fetchSpace.mockReset();
  });
  const answer = (body: unknown, status = 200) =>
    fetchSpace.mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it('applies events, and after a drop reconnects with backoff and fetches what it missed', async () => {
    answer(space([file('a.md')]));
    const { result } = renderHook(() => useLiveSpace(TOKEN, { kind: 'space', space: space([file('a.md')]) }, true));
    expect(FakeSocket.all[0]!.url).toBe(`ws://${window.location.host}/s/${TOKEN}/ws`);
    await act(async () => FakeSocket.all[0]!.open());
    expect(result.current.connected).toBe(true);
    act(() => FakeSocket.all[0]!.send({ type: 'file', file: { ...file('b.md'), updatedAt: '2026-11-02T00:00:00Z' } }));
    expect(result.current.state.kind === 'space' && result.current.state.space.files.map((f) => f.path)).toEqual(['a.md', 'b.md']);

    act(() => FakeSocket.all[0]!.drop());
    expect(result.current.connected).toBe(false);
    act(() => vi.advanceTimersByTime(999));
    expect(FakeSocket.all).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeSocket.all).toHaveLength(2);

    answer(space([file('c.md')]));
    await act(async () => FakeSocket.all[1]!.open());
    expect(result.current.state.kind === 'space' && result.current.state.space.files.map((f) => f.path)).toEqual(['c.md']);
  });

  it('stops for good once the link closes', async () => {
    const { result } = renderHook(() => useLiveSpace(TOKEN, { kind: 'space', space: space([]) }, true));
    answer(space([]));
    await act(async () => FakeSocket.all[0]!.open());
    act(() => FakeSocket.all[0]!.send({ type: 'closed', reason: 'rotated' }));
    act(() => FakeSocket.all[0]!.drop());
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.state).toEqual({ kind: 'unavailable', reason: 'missing' });
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('asks whether the link still works when the server refuses the socket', async () => {
    answer({ error: { code: 'SPACE_EXPIRED', message: 'Expired.' } }, 410);
    const { result } = renderHook(() => useLiveSpace(TOKEN, { kind: 'space', space: space([]) }, true));
    await act(async () => FakeSocket.all[0]!.drop());
    expect(result.current.state).toEqual({ kind: 'unavailable', reason: 'expired' });
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('closes the socket while paused', () => {
    const { rerender } = renderHook(({ live }) => useLiveSpace(TOKEN, { kind: 'space', space: space([]) }, live), { initialProps: { live: true } });
    rerender({ live: false });
    expect(FakeSocket.all[0]!.closed).toBe(true);
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeSocket.all).toHaveLength(1);
  });
});
