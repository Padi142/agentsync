import type { SpaceEvent } from '@agentsync/contract';

/**
 * Headers the Worker sets when it forwards a checked WebSocket upgrade to a `SpaceHub`, overwriting any
 * the client sent: the Share Link token it checked, and when the Space expires (ms since the epoch, or `never`).
 * Kept apart from `hub.ts`, which only loads inside the Workers runtime.
 */
export const HUB_SHARE_TOKEN_HEADER = 'X-AgentSync-Share-Token';
export const HUB_EXPIRES_AT_HEADER = 'X-AgentSync-Expires-At';
/** `SpaceHub` answers an upgrade with this status when the token isn't the Share Link it knows. */
export const HUB_STALE_TOKEN_STATUS = 409;

export type HubCloseReason = Extract<SpaceEvent, { type: 'closed' }>['reason'];
