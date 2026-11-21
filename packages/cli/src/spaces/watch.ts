import { spaceEventSchema, type SpaceEvent } from '@agentsync/contract';

/** Why a Share Link stopped working, from the server's `closed` event. */
export type ClosedReason = Extract<SpaceEvent, { type: 'closed' }>['reason'];

export interface WatchOptions {
  /** The Space's WebSocket URL. */
  url: string;
  /** Bring the local copy up to date with the Space. Runs after every (re)connect, before any event. */
  resync(): Promise<void>;
  /** Apply one `file`, `fileDeleted` or `space` event. Calls run one at a time, in order. */
  apply(event: Exclude<SpaceEvent, { type: 'closed' }>): Promise<void>;
  /** Stops the watch (Ctrl+C). */
  signal: AbortSignal;
  sleep(ms: number): Promise<void>;
  warn(text: string): void;
}

/** The longest wait between reconnects. */
const MAX_DELAY_MS = 30_000;

/**
 * Follow a Space's WebSocket until the server sends `closed` (returned) or `signal` aborts (`null`).
 * A dropped connection is reopened with backoff, and each reconnect resyncs first, so nothing that
 * changed meanwhile is missed. Any other failure of `resync` or `apply` (the link died, a bad path) ends it.
 */
export async function watchSpace(options: WatchOptions): Promise<ClosedReason | null> {
  let delay = 1000;
  for (;;) {
    const { closed, opened, failure } = await connectOnce(options);
    if (failure !== undefined && !transient(failure)) throw failure;
    if (closed || options.signal.aborted) return closed ?? null;
    if (opened) delay = 1000;
    // A link that died while we were away never opens again: resync says why (or that it still works).
    else await options.resync().catch((error: unknown) => {
      if (!transient(error)) throw error;
    });
    options.warn(`Lost the connection to the Space; reconnecting in ${delay / 1000}s…`);
    await Promise.race([options.sleep(delay), aborted(options.signal)]);
    if (options.signal.aborted) return null;
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A failure worth reconnecting after: the server could not be reached. Anything else ends the watch. */
const transient = (error: unknown) =>
  error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));

const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

/** One connection, until it closes: whether it opened, any `closed` reason, and a failure that closed it. */
function connectOnce({ url, resync, apply, signal, warn }: WatchOptions) {
  return new Promise<{ opened: boolean; closed?: ClosedReason; failure?: unknown }>((resolve) => {
    if (signal.aborted) return resolve({ opened: false });
    const socket = new WebSocket(url);
    const state: { opened: boolean; closed?: ClosedReason; failure?: unknown } = { opened: false };
    let queue = Promise.resolve();
    const enqueue = (work: () => Promise<void>) => {
      queue = queue.then(work).catch((error: unknown) => {
        state.failure ??= error;
        socket.close();
      });
    };
    const stop = () => socket.close();
    signal.addEventListener('abort', stop, { once: true });
    socket.addEventListener('open', () => {
      state.opened = true;
      enqueue(resync);
    });
    socket.addEventListener('message', (message) => {
      const parsed = spaceEventSchema.safeParse(json(String(message.data)));
      if (!parsed.success) return warn('Ignored a message from the server that this CLI can’t read.');
      const event = parsed.data;
      if (event.type === 'closed') state.closed = event.reason;
      else enqueue(() => apply(event));
    });
    socket.addEventListener('close', () => {
      signal.removeEventListener('abort', stop);
      void queue.then(() => resolve(state));
    });
  });
}
