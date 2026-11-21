import { SPACE_LIMITS, type Space, type SpaceExpiry } from '@agentsync/contract';
import { rpc } from '../../rpc';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the owner can do to a Space from the dashboard. */
export type SpaceActionId = 'extend' | 'permanent' | 'revive' | 'revive-permanent' | 'private' | 'public' | 'rotate' | 'delete';

export interface SpaceAction {
  id: SpaceActionId;
  label: string;
  /** Asked with `window.confirm` first. */
  confirm?: string;
  danger?: true;
}

/**
 * The `expires` that pushes a Space's expiry 7 days past its current one (or past now, once it
 * passed), in whole days and at most `SPACE_LIMITS.maxDays` away.
 */
export function extendExpiry(expiresAt: Date | null, now: Date = new Date()): SpaceExpiry {
  const left = expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS)) : 0;
  return `${Math.min(SPACE_LIMITS.maxDays, left + 7)}d`;
}

/** The actions that apply to a Space in its status, in the order the dashboard shows them. */
export function spaceActions(space: Pick<Space, 'status' | 'expiresAt' | 'title'>): SpaceAction[] {
  const rotate: SpaceAction = {
    id: 'rotate', label: 'Rotate link',
    confirm: 'Replace the Share Link with a new one?\n\nThe current link stops working for everyone who has it.',
  };
  const remove: SpaceAction = {
    id: 'delete', label: 'Delete', danger: true,
    confirm: `Delete “${space.title}”?\n\nIts files are removed now and its Share Link stops working. This can’t be undone.`,
  };
  switch (space.status) {
    case 'active':
      return [
        { id: 'extend', label: 'Extend 7 days' },
        ...(space.expiresAt ? [{ id: 'permanent', label: 'Make permanent' } as const] : []),
        { id: 'private', label: 'Make private' },
        rotate,
        remove,
      ];
    case 'expired':
      return [
        { id: 'revive', label: `Revive for ${SPACE_LIMITS.defaultDays} days` },
        { id: 'revive-permanent', label: 'Revive permanently' },
        { id: 'private', label: 'Keep as private' },
        remove,
      ];
    case 'private':
      return [{ id: 'public', label: 'Make public' }, rotate, remove];
  }
}

/** Run one action; resolves to what to tell the owner. */
export async function runSpaceAction(id: SpaceActionId, space: Pick<Space, 'id' | 'expiresAt'>): Promise<string> {
  const spaceId = space.id;
  switch (id) {
    case 'extend':
      await rpc.spaces.update({ spaceId, expires: extendExpiry(space.expiresAt) });
      return 'Extended by 7 days.';
    case 'permanent':
      await rpc.spaces.update({ spaceId, expires: 'never' });
      return 'The Share Link no longer expires.';
    case 'revive':
      await rpc.spaces.update({ spaceId, expires: `${SPACE_LIMITS.defaultDays}d` });
      return `Revived for ${SPACE_LIMITS.defaultDays} days, at the same link.`;
    case 'revive-permanent':
      await rpc.spaces.update({ spaceId, expires: 'never' });
      return 'Revived for good, at the same link.';
    case 'private':
      await rpc.spaces.update({ spaceId, private: true });
      return 'Private. The Share Link is off.';
    case 'public':
      await rpc.spaces.update({ spaceId, private: false });
      return 'Public. The Share Link works again.';
    case 'rotate':
      await rpc.spaces.rotateLink({ spaceId });
      return 'New Share Link ready. The old one stopped working.';
    case 'delete':
      await rpc.spaces.delete({ spaceId });
      return 'Space deleted.';
  }
}
