import {
  publicSpaceSchema, SPACE_PUBLIC_ROUTES, spaceErrorSchema, spaceEventSchema, type PublicSpace, type SpaceEvent,
} from '@agentsync/contract';
import { useEffect, useReducer, useState } from 'react';

/**
 * What a Share Link shows: the Space, or why it can't. `missing` covers unknown, deleted,
 * private and rotated links alike, so the page never tells which.
 */
export type Loaded = { kind: 'space'; space: PublicSpace } | { kind: 'unavailable'; reason: 'missing' | 'expired' };

/** Fetch a Share Link's Space. Throws only when the server can't be reached or answers nonsense. */
export async function loadPublicSpace(shareToken: string): Promise<Loaded> {
  const response = await fetch(SPACE_PUBLIC_ROUTES.json(shareToken), { headers: { accept: 'application/json' }, cache: 'no-store' });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return { kind: 'space', space: publicSpaceSchema.parse(body) };
  const code = spaceErrorSchema.safeParse(body).data?.error.code;
  if (code === 'SPACE_EXPIRED' || response.status === 410) return { kind: 'unavailable', reason: 'expired' };
  if (code === 'NOT_FOUND' || response.status === 404) return { kind: 'unavailable', reason: 'missing' };
  throw new Error(`The Space could not be loaded (HTTP ${response.status}).`);
}

export type LiveAction = { type: 'event'; event: SpaceEvent } | { type: 'loaded'; loaded: Loaded };

/** Apply a WebSocket event, or a fresh fetch, to what the viewer shows. */
export function liveReducer(state: Loaded, action: LiveAction): Loaded {
  if (action.type === 'loaded') return action.loaded;
  if (state.kind === 'unavailable') return state;
  const { event } = action;
  const { space } = state;
  switch (event.type) {
    case 'closed':
      return { kind: 'unavailable', reason: event.reason === 'expired' ? 'expired' : 'missing' };
    case 'space':
      return { kind: 'space', space: { ...space, ...event.space } };
    case 'file':
    case 'fileDeleted': {
      const path = event.type === 'file' ? event.file.path : event.path;
      const files = space.files.filter((f) => f.path !== path);
      if (event.type === 'file') files.push(event.file);
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const updatedAt = event.type === 'file' && event.file.updatedAt > space.updatedAt ? event.file.updatedAt : space.updatedAt;
      return { kind: 'space', space: { ...space, files, updatedAt, totalBytes: files.reduce((sum, f) => sum + f.size, 0) } };
    }
  }
}

/** Wait before reconnect `attempt` (from 0): 1 s, doubling, at most 30 s. */
export const reconnectDelay = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);

export const socketUrl = (shareToken: string, location: Pick<Location, 'protocol' | 'host'> = window.location) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${SPACE_PUBLIC_ROUTES.ws(shareToken)}`;

/**
 * A Share Link's Space, kept current over its WebSocket while `live`. Each (re)connect fetches the
 * Space again, so nothing missed while disconnected stays stale; so does a refused connection, which
 * may mean the link stopped working. Pausing closes the socket.
 * Once the link stops working it stays closed.
 */
export function useLiveSpace(shareToken: string, initial: Loaded, live: boolean) {
  const [state, dispatch] = useReducer(liveReducer, initial);
  const [connected, setConnected] = useState(false);
  const open = state.kind === 'space';
  useEffect(() => {
    if (!live || !open) return;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    const refresh = () => loadPublicSpace(shareToken).then(
      (loaded) => { if (!stopped) dispatch({ type: 'loaded', loaded }); },
      () => {}, // The next reconnect tries again.
    );
    const connect = () => {
      const ws = socket = new WebSocket(socketUrl(shareToken));
      let opened = false;
      ws.onopen = () => {
        opened = true;
        attempt = 0;
        setConnected(true);
        void refresh();
      };
      ws.onmessage = (message) => {
        let data: unknown;
        try {
          data = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const parsed = spaceEventSchema.safeParse(data);
        if (parsed.success) dispatch({ type: 'event', event: parsed.data });
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        // A refused upgrade may mean the link stopped working: ask, rather than retry forever.
        if (!opened) void refresh();
        timer = setTimeout(connect, reconnectDelay(attempt++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
      setConnected(false);
    };
  }, [shareToken, live, open]);
  return { state, connected };
}
