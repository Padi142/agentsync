import type { SpaceEvent } from '@agentsync/contract';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { HUB_EXPIRES_AT_HEADER, HUB_SHARE_TOKEN_HEADER, HUB_STALE_TOKEN_STATUS, type HubCloseReason } from './hub-protocol';

/**
 * One per Space (`idFromName(spaceId)`): holds the open WebSockets of its viewers (browsers and
 * `space pull --watch`) with the Hibernation API and sends them `SpaceEvent`s as JSON text frames.
 *
 * The Worker checks the Share Link in D1 before forwarding an upgrade, and calls `broadcast`, `rotate`
 * and `close` over RPC after each change. The hub remembers the current Share Link token and tags each
 * socket with the token it connected by, so an upgrade checked just before a rotation can't slip in after
 * it (it gets `HUB_STALE_TOKEN_STATUS`, and the Worker checks D1 again) and events reach only sockets of the current link.
 * An alarm at the Space's expiry tells viewers `closed: expired`. Clients send nothing but `ping`,
 * answered `pong` without waking the hub.
 */
export class SpaceHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private currentToken() {
    return this.ctx.storage.get<string>('shareToken');
  }

  /** Expire at `expiresAt` (ms), or never (`null`). */
  private async expireAt(expiresAt: number | null) {
    if (expiresAt === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(expiresAt);
  }

  override async fetch(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
    const token = request.headers.get(HUB_SHARE_TOKEN_HEADER);
    if (!token) return new Response('Missing Share Link token.', { status: 400 });
    const current = await this.currentToken();
    if (current && current !== token) return new Response('Not the current Share Link.', { status: HUB_STALE_TOKEN_STATUS });
    if (!current) await this.ctx.storage.put('shareToken', token);
    const expiresAt = request.headers.get(HUB_EXPIRES_AT_HEADER);
    if (expiresAt) await this.expireAt(expiresAt === 'never' ? null : Number(expiresAt));
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [token]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Send `event` to every socket of the current Share Link. A `space` event also moves the expiry alarm. */
  async broadcast(event: SpaceEvent) {
    if (event.type === 'space') {
      await this.expireAt(event.space.status === 'active' && event.space.expiresAt ? new Date(event.space.expiresAt).getTime() : null);
    }
    const current = await this.currentToken();
    if (current) this.send(this.ctx.getWebSockets(current), event);
  }

  /** The Share Link is now `token`: close every socket of an older one. */
  async rotate(token: string) {
    await this.ctx.storage.put('shareToken', token);
    const stale = this.ctx.getWebSockets().filter((socket) => !this.ctx.getTags(socket).includes(token));
    this.closeAll(stale, 'rotated');
  }

  /** Tell every socket the Share Link stopped working, then close them. A deleted Space's hub forgets everything. */
  async close(reason: HubCloseReason) {
    this.closeAll(this.ctx.getWebSockets(), reason);
    if (reason === 'deleted') await this.ctx.storage.deleteAll();
    else await this.ctx.storage.deleteAlarm();
  }

  override async alarm() {
    this.closeAll(this.ctx.getWebSockets(), 'expired');
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

  private closeAll(sockets: WebSocket[], reason: HubCloseReason) {
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
