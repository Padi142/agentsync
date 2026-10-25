import type { Machine, MachineOs, Target } from '@agentsync/contract';
import { and, asc, eq } from 'drizzle-orm';
import { createDb } from './index';
import { machine } from './schema';
import type { Env } from '../env';

const machineFields = {
  id: machine.id,
  nickname: machine.nickname,
  hostname: machine.hostname,
  os: machine.os,
  targets: machine.targets,
  createdAt: machine.createdAt,
  lastSeenAt: machine.lastSeenAt,
};

/** SHA-256 hex digest. Machine tokens and device codes are stored only as this hash. */
export async function hashSecret(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `as_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/**
 * Create a Machine and its token for the device flow stored under `deviceCodeHash`, and
 * delete that flow, all in one batch. The Machine is only inserted while the flow still
 * exists, so a retried or concurrent poll with the same code gets `null`, never a second
 * Machine or token. The token is returned here once and only its hash is stored.
 */
export async function registerMachine(
  env: Pick<Env, 'DB'>,
  deviceCodeHash: string,
  userId: string,
  details: { nickname: string; hostname: string; os: MachineOs; targets: Target[] },
): Promise<{ token: string; machine: Machine } | null> {
  const id = crypto.randomUUID();
  const token = newToken();
  const now = Date.now();
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO machine (id, user_id, nickname, hostname, os, targets, created_at, last_seen_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM device_authorization WHERE device_code_hash = ?)`,
    ).bind(id, userId, details.nickname, details.hostname, details.os, JSON.stringify(details.targets), now, now, deviceCodeHash),
    env.DB.prepare(
      'INSERT INTO machine_credential (token_hash, machine_id, created_at) SELECT ?, id, ? FROM machine WHERE id = ?',
    ).bind(await hashSecret(token), now, id),
    env.DB.prepare('DELETE FROM device_authorization WHERE device_code_hash = ?').bind(deviceCodeHash),
  ]);
  if (inserted.meta.changes !== 1) return null;
  return {
    token,
    machine: { id, ...details, createdAt: new Date(now), lastSeenAt: new Date(now) },
  };
}

/**
 * The Machine a token belongs to, with its user. Records the call as the Machine's
 * `lastSeenAt` in the same query. `null` for unknown or revoked tokens.
 */
export async function authenticateMachine(env: Pick<Env, 'DB'>, token: string) {
  const row = await env.DB.prepare(
    `UPDATE machine SET last_seen_at = ?
     WHERE id = (SELECT machine_id FROM machine_credential WHERE token_hash = ?)
     RETURNING id, user_id, nickname, hostname, os, targets, created_at, last_seen_at`,
  ).bind(Date.now(), await hashSecret(token)).first<{
    id: string; user_id: string; nickname: string; hostname: string; os: MachineOs; targets: string;
    created_at: number; last_seen_at: number;
  }>();
  if (!row) return null;
  const found: Machine = {
    id: row.id,
    nickname: row.nickname,
    hostname: row.hostname,
    os: row.os,
    targets: JSON.parse(row.targets),
    createdAt: new Date(row.created_at),
    lastSeenAt: new Date(row.last_seen_at),
  };
  return { userId: row.user_id, machine: found };
}

export function listMachines(env: Pick<Env, 'DB'>, userId: string): Promise<Machine[]> {
  return createDb(env).select(machineFields).from(machine)
    .where(eq(machine.userId, userId)).orderBy(asc(machine.createdAt)).all();
}

export function getMachine(env: Pick<Env, 'DB'>, userId: string, machineId: string): Promise<Machine | undefined> {
  return createDb(env).select(machineFields).from(machine)
    .where(and(eq(machine.id, machineId), eq(machine.userId, userId))).get();
}

export async function updateMachine(
  env: Pick<Env, 'DB'>,
  userId: string,
  machineId: string,
  changes: { nickname?: string; hostname?: string; targets?: Target[] },
): Promise<Machine | undefined> {
  const { nickname, hostname, targets } = changes;
  if (nickname === undefined && hostname === undefined && targets === undefined) return getMachine(env, userId, machineId);
  const [updated] = await createDb(env).update(machine)
    .set({ nickname, hostname, targets })
    .where(and(eq(machine.id, machineId), eq(machine.userId, userId)))
    .returning(machineFields);
  return updated;
}

/** Delete the Machine. Its token, Variables and their history go with it. */
export async function revokeMachine(env: Pick<Env, 'DB'>, userId: string, machineId: string) {
  const result = await createDb(env).delete(machine)
    .where(and(eq(machine.id, machineId), eq(machine.userId, userId))).run();
  return result.meta.changes > 0; // D1 counts the cascaded rows too.
}
