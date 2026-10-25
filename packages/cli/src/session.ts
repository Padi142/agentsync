import type { ContractClient } from '@agentsync/contract';
import { connect, normaliseServer } from './client.js';
import type { Context } from './context.js';
import { CliError, EXIT, usage } from './exit.js';

/** A client that acts as this Machine. Fails with the auth exit code if it is not registered. */
export function machineClient(ctx: Context, timeoutMs?: number): ContractClient {
  const { config, flags } = ctx;
  if (!config.token || !config.server) {
    throw new CliError('This Machine is not registered. Run `agentsync init` first.', EXIT.auth);
  }
  if (flags.server && normaliseServer(flags.server) !== config.server) {
    throw usage(`This Machine is registered with ${config.server}, not ${flags.server}.`);
  }
  return connect(ctx.io, config.server, config.token, timeoutMs);
}

export function machineId(ctx: Context): string {
  return ctx.config.machineId!;
}
