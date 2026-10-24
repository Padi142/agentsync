import type { MachineVariables, VariableMap } from '@agentsync/contract';
import { and, desc, eq } from 'drizzle-orm';
import { createDb } from './index';
import { writeRevision } from './revisions';
import { machineVariables, machineVariablesRevision } from './schema';
import type { Env } from '../env';

/** A Machine's current Variables, or the empty revision 0. The caller checks ownership. */
export async function getVariables(env: Pick<Env, 'DB'>, machineId: string): Promise<MachineVariables> {
  const row = await createDb(env)
    .select({ variables: machineVariablesRevision.variables, revision: machineVariables.revision })
    .from(machineVariables)
    .innerJoin(machineVariablesRevision, and(
      eq(machineVariablesRevision.machineId, machineVariables.machineId),
      eq(machineVariablesRevision.revision, machineVariables.revision),
    ))
    .where(eq(machineVariables.machineId, machineId))
    .get();
  return { machineId, variables: row?.variables ?? {}, revision: row?.revision ?? 0 };
}

/** Replace a Machine's whole Variable map if its head is still `expectedRevision`. */
export async function putVariables(
  env: Pick<Env, 'DB'>,
  machineId: string,
  variables: VariableMap,
  expectedRevision: number,
): Promise<{ ok: true; variables: MachineVariables } | { ok: false; currentRevision: number }> {
  const result = await writeRevision(env.DB, 'variables', machineId, JSON.stringify(variables), expectedRevision);
  if (!result.ok) return result;
  return { ok: true, variables: { machineId, variables, revision: result.revision } };
}

/** Every saved Variable map, newest first. The caller checks ownership. */
export function variablesHistory(env: Pick<Env, 'DB'>, machineId: string) {
  return createDb(env)
    .select({
      revision: machineVariablesRevision.revision,
      variables: machineVariablesRevision.variables,
      createdAt: machineVariablesRevision.createdAt,
    })
    .from(machineVariablesRevision)
    .where(eq(machineVariablesRevision.machineId, machineId))
    .orderBy(desc(machineVariablesRevision.revision))
    .all();
}
