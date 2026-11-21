import { afterEach, describe, expect, it, vi } from 'vitest';

const { update, rotateLink } = vi.hoisted(() => ({ update: vi.fn(), rotateLink: vi.fn() }));
vi.mock('../src/rpc', () => ({ rpc: { spaces: { update, rotateLink, delete: vi.fn() } } }));

const { extendExpiry, runSpaceAction, spaceActions } = await import('../src/components/spaces/actions');

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-21T12:00:00Z');

afterEach(() => vi.clearAllMocks());

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
