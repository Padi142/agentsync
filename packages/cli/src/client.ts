import type { ContractClient } from '@agentsync/contract';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { Io } from './io.js';

/**
 * A typed client for the AgentSync server. A Machine token goes in `Authorization`. The CLI
 * sends no Origin header and no cookies, which is what lets it past the server's CSRF check.
 */
export function connect(io: Io, server: string, token?: string, timeoutMs?: number): ContractClient {
  return createORPCClient<ContractClient>(
    new RPCLink({
      url: `${server}/rpc`,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      fetch: (request) => io.fetch(request, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined),
    }),
  );
}

/** Check and normalise a `--server` value. */
export function normaliseServer(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}
