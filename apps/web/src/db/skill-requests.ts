import { SKILL_REQUEST_LIMITS, type SkillAssignment } from '@agentsync/contract';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { createDb } from './index';
import { machine, skill, skillRequest, type StoredAudits, type StoredProposal } from './schema';
import type { Env } from '../env';

export type SkillRequestRow = typeof skillRequest.$inferSelect;

const OPEN = ['resolving', 'open'] as const;
/** How long a resolving request holds its place after its last progress: an interrupted one soon frees it. */
const RESOLVING_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** With a request's at most `SKILL_REQUEST_LIMITS.skills` ids, this keeps a statement under D1's 100 bound parameters. */
const MACHINES_PER_STATEMENT = 100 - SKILL_REQUEST_LIMITS.skills - 1;

/** A user's open Skill Requests (resolving ones included), oldest first, with the asking Machine's nickname. */
export function openRequestRows(env: Pick<Env, 'DB'>, userId: string, now = new Date()) {
  return createDb(env).select({ request: skillRequest, nickname: machine.nickname }).from(skillRequest)
    .innerJoin(machine, eq(machine.id, skillRequest.machineId))
    .where(and(eq(skillRequest.userId, userId), inArray(skillRequest.status, OPEN), gt(skillRequest.expiresAt, now)))
    .orderBy(asc(skillRequest.createdAt)).all();
}

/** One of a user's Skill Requests, whatever its status, with the asking Machine's nickname. */
export function getRequestRow(env: Pick<Env, 'DB'>, userId: string, requestId: string) {
  return createDb(env).select({ request: skillRequest, nickname: machine.nickname }).from(skillRequest)
    .innerJoin(machine, eq(machine.id, skillRequest.machineId))
    .where(and(eq(skillRequest.id, requestId), eq(skillRequest.userId, userId))).get();
}

/** The Machine's open request for a repository, as it named it, if it has one. */
export function openRequestFor(env: Pick<Env, 'DB'>, machineId: string, source: string, now = new Date()) {
  return createDb(env).select().from(skillRequest)
    .where(and(eq(skillRequest.machineId, machineId), eq(skillRequest.source, source), inArray(skillRequest.status, OPEN), gt(skillRequest.expiresAt, now)))
    .get();
}

/**
 * The Machine's request for a repository that a browser approved in the last `SKILL_REQUEST_LIMITS.hours`,
 * newest first, if it asked for exactly `names`: what a rerun of the same `skills add` finishes installing.
 */
export async function approvedRequestFor(env: Pick<Env, 'DB'>, machineId: string, source: string, names: string[] | null, now = new Date()) {
  const rows = await createDb(env).select().from(skillRequest)
    .where(and(
      eq(skillRequest.machineId, machineId), eq(skillRequest.source, source), eq(skillRequest.status, 'approved'),
      gt(skillRequest.decidedAt, new Date(now.getTime() - SKILL_REQUEST_LIMITS.hours * HOUR_MS)),
    ))
    .orderBy(desc(skillRequest.decidedAt)).all();
  return rows.find((row) => JSON.stringify(row.names) === JSON.stringify(names));
}

export interface NewRequest {
  userId: string;
  machineId: string;
  repo: { id: number; fullName: string };
  source: string;
  commit: string;
  names: string[] | null;
  skills: StoredProposal[];
}

/**
 * Save a new resolving request, replacing `replaces` (an open request of the same Machine for the same
 * repository, with other names). `null` if the account already has as many open requests as it may, or
 * the Machine already has an open one for this repository (a racing call made it). The checks and the
 * insert are one statement, so two racing requests can't both get the last place or both be made.
 */
export async function insertRequest(env: Pick<Env, 'DB'>, details: NewRequest, replaces: string | null, now = new Date()): Promise<SkillRequestRow | null> {
  const row: SkillRequestRow = {
    id: crypto.randomUUID(),
    userId: details.userId,
    machineId: details.machineId,
    repoId: details.repo.id,
    repoFullName: details.repo.fullName,
    source: details.source,
    commit: details.commit,
    names: details.names,
    skills: details.skills,
    audits: null,
    status: 'resolving',
    added: [],
    createdAt: now,
    expiresAt: new Date(now.getTime() + RESOLVING_MS),
    decidedAt: null,
    decisionId: null,
  };
  const [, inserted] = await env.DB.batch([
    env.DB.prepare('DELETE FROM skill_request WHERE id = ? AND user_id = ?').bind(replaces ?? '', details.userId),
    env.DB.prepare(
      `INSERT INTO skill_request (id, user_id, machine_id, repo_id, repo_full_name, source, "commit", names, skills, audits, status, added, created_at, expires_at, decided_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'resolving', '[]', ?, ?, NULL
       WHERE (SELECT count(*) FROM skill_request WHERE user_id = ? AND status IN ('resolving', 'open') AND expires_at > ?) < ?
         AND NOT EXISTS (SELECT 1 FROM skill_request WHERE machine_id = ? AND source = ? AND status IN ('resolving', 'open') AND expires_at > ?)`,
    ).bind(
      row.id, row.userId, row.machineId, row.repoId, row.repoFullName, row.source, row.commit,
      row.names ? JSON.stringify(row.names) : null, JSON.stringify(row.skills), now.getTime(), row.expiresAt.getTime(),
      row.userId, now.getTime(), SKILL_REQUEST_LIMITS.open,
      row.machineId, row.source, now.getTime(),
    ),
  ]);
  return inserted!.meta.changes === 1 ? row : null;
}

/**
 * Save the Pins resolved so far, which holds the request's place a while longer; with `audits`, every Pin
 * is resolved and the request opens for `SKILL_REQUEST_LIMITS.hours`. Returns the saved request, or
 * `undefined` if it had already lost its place (it stalled too long), so it stays closed.
 */
export function saveResolution(env: Pick<Env, 'DB'>, requestId: string, skills: StoredProposal[], audits: Record<string, StoredAudits> | null, now = new Date()) {
  return createDb(env).update(skillRequest)
    .set(audits
      ? { skills, audits, status: 'open', expiresAt: new Date(now.getTime() + SKILL_REQUEST_LIMITS.hours * HOUR_MS) }
      : { skills, expiresAt: new Date(now.getTime() + RESOLVING_MS) })
    .where(and(eq(skillRequest.id, requestId), eq(skillRequest.status, 'resolving'), gt(skillRequest.expiresAt, now)))
    .returning().get();
}

/** Close an open request as rejected. Returns whether it was open. */
export async function rejectRequestRow(env: Pick<Env, 'DB'>, userId: string, requestId: string, now = new Date()) {
  const result = await createDb(env).update(skillRequest).set({ status: 'rejected', decidedAt: now })
    .where(and(eq(skillRequest.id, requestId), eq(skillRequest.userId, userId), eq(skillRequest.status, 'open'), gt(skillRequest.expiresAt, now))).run();
  return result.meta.changes === 1;
}

/** A Skill to add on approval: everything but what `approveRequestRow` fills in. */
export interface ApprovedSkill {
  name: string;
  path: string;
  pin: { commit: string; treeSha: string; installedHash: string; committedAt: number };
  audits: StoredAudits;
}

/**
 * Approve an open request in one transaction: close it, then add each Skill (one statement apiece,
 * under D1's bind limit) with its first Pin move, assign them, and lift any exclusion of their names.
 * Every insert depends on this call having closed the request, which it tells by the random decision id
 * it wrote, so of two racing approvals (or an approval and a rejection) only one changes anything, and a
 * name taken meanwhile is skipped.
 * Returns the names added, or `null` if the request was no longer open.
 */
export async function approveRequestRow(
  env: Pick<Env, 'DB'>,
  request: SkillRequestRow,
  skills: ApprovedSkill[],
  assignment: SkillAssignment,
  now = new Date(),
): Promise<string[] | null> {
  const at = now.getTime();
  const decisionId = crypto.randomUUID();
  const closedByThisCall = `EXISTS (SELECT 1 FROM skill_request WHERE id = ? AND decision_id = ?)`;
  const aliases = request.source === request.repoFullName.toLowerCase() ? [] : [request.source];
  const ids = skills.map(() => crypto.randomUUID());
  const idList = ids.map(() => '?').join(', ');
  const machineIds = assignment.to === 'chosen' ? [...new Set(assignment.machineIds)] : [];
  const sources = [...new Set([request.source, request.repoFullName.toLowerCase()])];
  const statements = [
    env.DB.prepare(`UPDATE skill_request SET status = 'approved', decided_at = ?, decision_id = ?, added = ? WHERE id = ? AND status = 'open' AND expires_at > ?`)
      .bind(at, decisionId, JSON.stringify(skills.map((item) => item.name)), request.id, at),
    ...skills.map((item, index) => env.DB.prepare(
      `INSERT OR IGNORE INTO skill (id, user_id, name, repo_id, repo_full_name, repo_aliases, path, pin_commit, pin_tree_sha, pin_installed_hash,
         pin_committed_at, assignment, auto_update, newer, update_pushed_at, audits, checked_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '[]', NULL, ?, NULL, ? WHERE ${closedByThisCall}`,
    ).bind(
      ids[index]!, request.userId, item.name, request.repoId, request.repoFullName, JSON.stringify(aliases), item.path,
      item.pin.commit, item.pin.treeSha, item.pin.installedHash, item.pin.committedAt, assignment.to, JSON.stringify(item.audits), at,
      request.id, decisionId,
    )),
    env.DB.prepare(
      `INSERT INTO skill_pin_move (id, skill_id, from_commit, to_commit, to_installed_hash, kind, audits, at)
       SELECT lower(hex(randomblob(16))), id, NULL, pin_commit, pin_installed_hash, 'added', audits, created_at
       FROM skill WHERE id IN (${idList})`,
    ).bind(...ids),
    // Chosen Machines must be the user's own; others are left out. Chunked to stay under D1's 100 bound parameters.
    ...Array.from({ length: Math.ceil(machineIds.length / MACHINES_PER_STATEMENT) }, (_, chunk) => {
      const some = machineIds.slice(chunk * MACHINES_PER_STATEMENT, (chunk + 1) * MACHINES_PER_STATEMENT);
      return env.DB.prepare(
        `INSERT INTO skill_machine (skill_id, machine_id)
         SELECT s.id, m.id FROM skill s, machine m WHERE s.id IN (${idList}) AND m.id IN (${some.map(() => '?').join(', ')}) AND m.user_id = ?`,
      ).bind(...ids, ...some, request.userId);
    }),
    ...sources.map((source) => env.DB.prepare(
      `DELETE FROM skill_exclusion WHERE user_id = ? AND repo = ? AND name IN (SELECT name FROM skill WHERE id IN (${idList}))`,
    ).bind(request.userId, source, ...ids)),
  ];
  const [closed] = await env.DB.batch(statements);
  if (closed!.meta.changes !== 1) return null;
  const added = await createDb(env).select({ name: skill.name }).from(skill).where(inArray(skill.id, ids)).all();
  const names = skills.map((item) => item.name).filter((name) => added.some((row) => row.name === name));
  // A name taken between the check and the batch was skipped: say only what was added.
  if (names.length !== skills.length) {
    await createDb(env).update(skillRequest).set({ added: names }).where(eq(skillRequest.id, request.id)).run();
  }
  return names;
}
