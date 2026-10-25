import type { ContractClient } from '@agentsync/contract';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

/**
 * The typed API client. Routes load data in the browser only (the root route has `ssr: false`),
 * so same-origin fetches carry the session cookie and the app's Origin header.
 */
export const rpc = createORPCClient<ContractClient>(
  new RPCLink({ url: () => `${window.location.origin}/rpc` }),
);
