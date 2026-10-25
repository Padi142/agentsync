import type { ContractClient, MachineVariables } from '@agentsync/contract';
import { ORPCError } from '@orpc/client';
import { usage } from './exit.js';

/** Parse `KEY=VALUE` flags. */
export function parseAssignments(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf('=');
    if (index < 1) throw usage(`--var must look like KEY=VALUE, not "${value}".`);
    result[value.slice(0, index)] = value.slice(index + 1);
  }
  return result;
}

/**
 * Set and unset some of a Machine's Variables. The server replaces the whole map, so on
 * `CONFLICT` (someone else saved meanwhile) re-read it and apply the same change again.
 */
export async function changeVariables(
  client: ContractClient,
  machineId: string,
  set: Record<string, string>,
  unset: string[] = [],
): Promise<MachineVariables> {
  for (let attempt = 0; ; attempt++) {
    const current = await client.variables.get({ machineId });
    const variables = { ...current.variables, ...set };
    for (const name of unset) delete variables[name];
    try {
      return await client.variables.put({ machineId, variables, expectedRevision: current.revision });
    } catch (error) {
      if (attempt >= 2 || !(error instanceof ORPCError && error.code === 'CONFLICT')) throw error;
    }
  }
}
