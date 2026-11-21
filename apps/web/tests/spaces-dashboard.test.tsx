// @vitest-environment jsdom
import { SPACE_OWNER_ROUTES, type SpaceDetail } from '@agentsync/contract';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { update, rotateLink } = vi.hoisted(() => ({ update: vi.fn(), rotateLink: vi.fn() }));
vi.mock('../src/rpc', () => ({ rpc: { spaces: { update, rotateLink, delete: vi.fn() } } }));

const { extendExpiry, runSpaceAction, spaceActions } = await import('../src/components/spaces/actions');
const { SpaceFilesSection } = await import('../src/routes/_app/spaces.$spaceId');

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-21T12:00:00Z');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('extendExpiry', () => {
  it('adds 7 days to what is left, rounding the remainder up to whole days', () => {
    expect(extendExpiry(new Date(now.getTime() + 2.2 * DAY), now)).toBe('10d');
    expect(extendExpiry(new Date(now.getTime() + 3 * DAY), now)).toBe('10d');
  });

  it('counts from now once the expiry passed, and stops at the longest allowed', () => {
    expect(extendExpiry(new Date(now.getTime() - 5 * DAY), now)).toBe('7d');
    expect(extendExpiry(new Date(now.getTime() + 362 * DAY), now)).toBe('365d');
  });
});

describe('spaceActions', () => {
  const ids = (status: 'active' | 'expired' | 'private', expiresAt: Date | null = now) =>
    spaceActions({ status, expiresAt, title: 'Report' }).map((a) => a.id);

  it('offers what fits each status', () => {
    expect(ids('active')).toEqual(['extend', 'permanent', 'private', 'rotate', 'delete']);
    expect(ids('active', null)).toEqual(['private', 'rotate', 'delete']);
    expect(ids('expired')).toEqual(['revive', 'revive-permanent', 'private', 'delete']);
    expect(ids('private')).toEqual(['public', 'rotate', 'delete']);
  });

  it('asks before rotating the link or deleting', () => {
    const confirmed = spaceActions({ status: 'active', expiresAt: now, title: 'Report' }).filter((a) => a.confirm).map((a) => a.id);
    expect(confirmed).toEqual(['rotate', 'delete']);
  });
});

it('revives an expired Space at its link by setting an expiry, and turns the link off and on with `private`', async () => {
  const space = { id: 's1', expiresAt: new Date(now.getTime() - DAY) };
  await runSpaceAction('revive', space);
  await runSpaceAction('revive-permanent', space);
  await runSpaceAction('private', space);
  await runSpaceAction('public', space);
  await runSpaceAction('rotate', space);
  expect(update.mock.calls.map(([input]) => input)).toEqual([
    { spaceId: 's1', expires: '7d' },
    { spaceId: 's1', expires: 'never' },
    { spaceId: 's1', private: true },
    { spaceId: 's1', private: false },
  ]);
  expect(rotateLink).toHaveBeenCalledWith({ spaceId: 's1' });
});

describe('SpaceFilesSection', () => {
  const token = 'a'.repeat(32);
  const makeSpace = (status: SpaceDetail['status'], empty = false): Pick<SpaceDetail, 'id' | 'status' | 'shareUrl' | 'fileCount' | 'totalBytes' | 'files'> => ({
    id: 'space-1',
    status,
    shareUrl: `https://agentsync.test/s/${token}`,
    fileCount: empty ? 0 : 1,
    totalBytes: empty ? 0 : 42,
    files: empty ? [] : [{
      path: 'reports/summary.html',
      size: 42,
      contentType: 'text/html; charset=utf-8',
      sha256: '0'.repeat(64),
      updatedAt: now,
    }],
  });

  it('links to the public viewer when active and still offers owner downloads', () => {
    const { getByRole, getByTitle } = render(<SpaceFilesSection space={makeSpace('active')} removing={null} onRemove={vi.fn()} />);
    expect(getByTitle('Open in the viewer').getAttribute('href')).toBe(`https://agentsync.test/s/${token}?file=reports%2Fsummary.html`);
    expect(getByRole('link', { name: 'Download reports/summary.html' }).getAttribute('href'))
      .toBe(SPACE_OWNER_ROUTES.raw('space-1', 'reports/summary.html'));
    expect(getByRole('link', { name: 'Download ZIP' }).getAttribute('href')).toBe(SPACE_OWNER_ROUTES.zip('space-1'));
  });

  it('links private and expired Space files and ZIP through the owner routes', () => {
    for (const status of ['private', 'expired'] as const) {
      cleanup();
      const { getByRole, getByTitle } = render(<SpaceFilesSection space={makeSpace(status)} removing={null} onRemove={vi.fn()} />);
      expect(getByTitle('Open file').getAttribute('href')).toBe(SPACE_OWNER_ROUTES.raw('space-1', 'reports/summary.html'));
      expect(getByRole('link', { name: 'Download reports/summary.html' }).getAttribute('href'))
        .toBe(SPACE_OWNER_ROUTES.raw('space-1', 'reports/summary.html'));
      expect(getByRole('link', { name: 'Download ZIP' }).getAttribute('href')).toBe(SPACE_OWNER_ROUTES.zip('space-1'));
    }
  });

  it('omits Download ZIP when the Space has no files', () => {
    const { queryByRole, getByText } = render(<SpaceFilesSection space={makeSpace('private', true)} removing={null} onRemove={vi.fn()} />);
    expect(queryByRole('link', { name: 'Download ZIP' })).toBeNull();
    expect(getByText('No files yet.')).toBeTruthy();
  });
});
