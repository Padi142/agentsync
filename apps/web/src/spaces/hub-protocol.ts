import type { SpaceRow } from '../db/spaces';

/**
 * What a `SpaceHub` needs to know of its Space, as D1 had it at `version` (the row's `updatedAt`, ms):
 * the current Share Link token and when it expires (ms, `null`: never). The Worker sends it with every
 * upgrade and broadcast; the hub keeps the newest it has seen and ignores older ones, so a stale request
 * can't bring back a rotated link or an old expiry. Kept apart from `hub.ts`, which only loads in workerd.
 */
export interface HubState {
  token: string;
  expiresAt: number | null;
  version: number;
}

/** The hub state of a Space that isn't private. */
export const hubStateOf = (row: SpaceRow): HubState => ({
  token: row.shareToken,
  expiresAt: row.expiresAt?.getTime() ?? null,
  version: row.updatedAt.getTime(),
});

/** The header the Worker sets (as JSON `HubState`) when it forwards a checked upgrade, overwriting any the client sent. */
export const HUB_STATE_HEADER = 'X-AgentSync-Hub-State';
/**
 * `SpaceHub` answers an upgrade with this status when it knows newer state than the upgrade carries, or
 * the Space was closed (made private, deleted) or has expired: the Worker then checks D1 again.
 */
export const HUB_STALE_STATUS = 409;

/** The `closed` reasons the Worker asks for; the hub itself sends `rotated` and `expired`. */
export type HubCloseReason = 'private' | 'deleted';
