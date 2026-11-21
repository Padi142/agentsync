import type { SpaceEvent } from '@agentsync/contract';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { HUB_STALE_STATUS, HUB_STATE_HEADER, type HubCloseReason, type HubState } from './hub-protocol';

/** How long a deleted Space's hub keeps refusing upgrades (any still in flight) before it forgets everything. */
const DELETED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** What the hub stores: the newest `HubState` it has seen, and whether the Share Link was turned off since. */
interface Stored extends HubState {
  closed: HubCloseReason | null;
}

/**
 * One per Space (`idFromName(spaceId)`): holds the open WebSockets of its viewers (browsers and
 * `space pull --watch`) with the Hibernation API and sends them `SpaceEvent`s as JSON text frames.
 *
 * The Worker checks the Share Link in D1 before forwarding an upgrade, and sends the Space's `HubState`
 * with it and with every broadcast. The hub keeps the newest state (by `version`): a new token closes the
 * sockets of the old one (`rotated`), the expiry is an alarm that closes them all (`expired`). Sockets are
 * tagged with their token, and events reach only those of the current one. An upgrade carrying older state,
 * or arriving after the Space was made private, deleted or expired, gets `HUB_STALE_STATUS`, and the Worker
 * checks D1 again. Clients send nothing but `ping`, answered `pong` without waking the hub.
 */
export class SpaceHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private stored() {
    return this.ctx.storage.get<Stored>('state');
  }

  /** Adopt `incoming` unless the hub already knows newer state (or that the Space is gone). Returns what it holds now. */
  private async apply(incoming: HubState): Promise<Stored> {
    const stored = await this.stored();
    if (stored && (stored.closed === 'deleted' || incoming.version < stored.version ||
        (incoming.version === stored.version && (stored.closed || stored.token !== incoming.token)))) {
      return stored;
    }
    const next: Stored = { ...incoming, closed: null };
    await this.ctx.storage.put('state', next);
    if (next.expiresAt === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next.expiresAt);
    if (stored && stored.token !== next.token) {
      this.closeAll(this.ctx.getWebSockets().filter((socket) => !this.ctx.getTags(socket).includes(next.token)), 'rotated');
    }
    return next;
  }

  override async fetch(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
    let incoming: HubState;
    try {
      incoming = JSON.parse(request.headers.get(HUB_STATE_HEADER) ?? '') as HubState;
    } catch {
      return new Response('Missing hub state.', { status: 400 });
    }
    const state = await this.apply(incoming);
    if (state.closed || state.token !== incoming.token || state.version !== incoming.version ||
        (state.expiresAt !== null && state.expiresAt <= Date.now())) {
      return new Response('Stale Share Link state.', { status: HUB_STALE_STATUS });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [state.token]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Adopt `state` (if newer), then send `event` to every socket of the current Share Link. */
  async broadcast(event: SpaceEvent, state: HubState) {
    const current = await this.apply(state);
    if (!current.closed) this.send(this.ctx.getWebSockets(current.token), event);
  }

  /** Adopt `state` (if newer), e.g. after the Share Link was rotated. */
  async sync(state: HubState) {
    await this.apply(state);
  }

  /**
   * The Share Link was turned off at `version`: tell every socket, close them, and refuse upgrades until
   * newer state comes (a private Space made public again). A deleted Space's hub is cleared a day later.
   */
  async close(reason: HubCloseReason, version: number) {
    this.closeAll(this.ctx.getWebSockets(), reason);
    const stored = await this.stored();
    await this.ctx.storage.put('state', {
      token: stored?.token ?? '', expiresAt: null, version: Math.max(version, stored?.version ?? 0), closed: reason,
    } satisfies Stored);
    if (reason === 'deleted') await this.ctx.storage.setAlarm(Date.now() + DELETED_RETENTION_MS);
    else await this.ctx.storage.deleteAlarm();
  }

  override async alarm() {
    if ((await this.stored())?.closed === 'deleted') await this.ctx.storage.deleteAll();
    else this.closeAll(this.ctx.getWebSockets(), 'expired');
  }

  private send(sockets: WebSocket[], event: SpaceEvent) {
    const message = JSON.stringify(event);
    for (const socket of sockets) {
      try {
        socket.send(message);
      } catch {
        // Already closing; its close handler cleans up.
      }
    }
  }

  private closeAll(sockets: WebSocket[], reason: Extract<SpaceEvent, { type: 'closed' }>['reason']) {
    this.send(sockets, { type: 'closed', reason });
    for (const socket of sockets) {
      try {
        socket.close(1000, reason);
      } catch {
        // Already closed.
      }
    }
  }

  override webSocketMessage() {
    // Viewers only listen.
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string) {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}
