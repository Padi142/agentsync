import type { Audits, ScannedSkill, SkillAssignment, SkillSyncResult } from '@agentsync/contract';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { createDb } from './index';
import {
  machine, machineSkillReport, skill, skillExclusion, skillFolderVersion, skillMachine, skillPinMove, skillSettings,
  type FolderVersion, type StoredAudits,
} from './schema';
import type { Env } from '../env';

export type SkillRow = typeof skill.$inferSelect;
export type ReportRow = typeof machineSkillReport.$inferSelect;

export const noAudits: Audits = { gen: null, socket: null, snyk: null };

/** Verdicts as the JSON columns keep them. */
export function storedAudits(audits: Audits): StoredAudits {
  const store = (audit: Audits['gen']) => audit && { risk: audit.risk, analyzedAt: audit.analyzedAt.toISOString() };
  return { gen: store(audits.gen), socket: store(audits.socket), snyk: store(audits.snyk) };
}

/** Verdicts read back from a JSON column; none for `null`. */
export function auditsOf(stored: StoredAudits | null): Audits {
  if (!stored) return noAudits;
  const read = (audit: StoredAudits['gen']) => audit && { risk: audit.risk, analyzedAt: new Date(audit.analyzedAt) };
  return { gen: read(stored.gen), socket: read(stored.socket), snyk: read(stored.snyk) };
}

export function listSkillRows(env: Pick<Env, 'DB'>, userId: string): Promise<SkillRow[]> {
  return createDb(env).select().from(skill).where(eq(skill.userId, userId)).orderBy(asc(skill.name)).all();
}

export function getSkillRow(env: Pick<Env, 'DB'>, userId: string, skillId: string): Promise<SkillRow | undefined> {
  return createDb(env).select().from(skill).where(and(eq(skill.id, skillId), eq(skill.userId, userId))).get();
}

/** The chosen Machines of each Skill with `assignment = 'chosen'`. */
export async function chosenMachines(env: Pick<Env, 'DB'>, skillIds: string[]): Promise<Map<string, string[]>> {
  const chosen = new Map<string, string[]>();
  if (!skillIds.length) return chosen;
  const rows = await createDb(env).select().from(skillMachine).where(inArray(skillMachine.skillId, skillIds)).all();
  for (const row of rows) chosen.set(row.skillId, [...(chosen.get(row.skillId) ?? []), row.machineId]);
  return chosen;
}

/** The installed hashes of every Pin each Skill has had, the current one included. */
export async function pinHashes(env: Pick<Env, 'DB'>, skillIds: string[]): Promise<Map<string, Set<string>>> {
  const hashes = new Map<string, Set<string>>();
  if (!skillIds.length) return hashes;
  const rows = await createDb(env).select({ skillId: skillPinMove.skillId, hash: skillPinMove.toInstalledHash })
    .from(skillPinMove).where(inArray(skillPinMove.skillId, skillIds)).all();
  for (const row of rows) hashes.set(row.skillId, (hashes.get(row.skillId) ?? new Set()).add(row.hash));
  return hashes;
}

/** The last Skills report of each of a user's Machines. */
export async function reportsFor(env: Pick<Env, 'DB'>, userId: string): Promise<Map<string, ReportRow>> {
  const rows = await createDb(env).select({ report: machineSkillReport }).from(machineSkillReport)
    .innerJoin(machine, eq(machine.id, machineSkillReport.machineId))
    .where(eq(machine.userId, userId)).all();
  return new Map(rows.map(({ report }) => [report.machineId, report]));
}

export async function getReport(env: Pick<Env, 'DB'>, machineId: string): Promise<ReportRow | undefined> {
  return createDb(env).select().from(machineSkillReport).where(eq(machineSkillReport.machineId, machineId)).get();
}

/** Save a Machine's scan, and the results of its `skills sync` if it sent them. */
export async function saveReport(env: Pick<Env, 'DB'>, machineId: string, scan: ScannedSkill[], results?: SkillSyncResult[]) {
  const now = new Date();
  await createDb(env).insert(machineSkillReport)
    .values({ machineId, scan, reportedAt: now, ...(results ? { results, syncedAt: now } : {}) })
    .onConflictDoUpdate({
      target: machineSkillReport.machineId,
      set: { scan, reportedAt: now, ...(results ? { results, syncedAt: now } : {}) },
    })
    .run();
}

/** The Skills assigned to a Machine: every `all` Skill of its user, and the `chosen` ones that list it. */
export function assignedSkillRows(env: Pick<Env, 'DB'>, userId: string, machineId: string): Promise<SkillRow[]> {
  const db = createDb(env);
  const chosenHere = db.select({ id: skillMachine.skillId }).from(skillMachine).where(eq(skillMachine.machineId, machineId));
  return db.select().from(skill)
    .where(and(eq(skill.userId, userId), or(eq(skill.assignment, 'all'), inArray(skill.id, chosenHere))))
    .orderBy(asc(skill.name)).all();
}

export interface NewSkill {
  userId: string;
  name: string;
  repo: { id: number; fullName: string };
  /** Old names (lowercase) GitHub redirected to it. */
  aliases: string[];
  path: string;
  pin: FolderVersion;
  audits: Audits;
}

/** Add a Skill, assigned to all Machines, with its first Pin move. `null` if the name is taken. */
export async function insertSkill(env: Pick<Env, 'DB'>, details: NewSkill): Promise<SkillRow | null> {
  const id = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env);
  const row: SkillRow = {
    id,
    userId: details.userId,
    name: details.name,
    repoId: details.repo.id,
    repoFullName: details.repo.fullName,
    repoAliases: details.aliases,
    path: details.path,
    pinCommit: details.pin.commit,
    pinTreeSha: details.pin.treeSha,
    pinInstalledHash: details.pin.installedHash,
    pinCommittedAt: new Date(details.pin.committedAt),
    assignment: 'all',
    autoUpdate: true,
    newer: [],
    updatePushedAt: null,
    audits: storedAudits(details.audits),
    checkedAt: null,
    createdAt: now,
  };
  try {
    await db.batch([
      db.insert(skill).values(row),
      db.insert(skillPinMove).values({
        id: crypto.randomUUID(), skillId: id, fromCommit: null, toCommit: details.pin.commit,
        toInstalledHash: details.pin.installedHash, kind: 'added', audits: storedAudits(details.audits), at: now,
      }),
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) return null;
    throw error;
  }
  return row;
}

/**
 * Move a Skill's Pin from `from` to `to` and record it, in one batch. The update only applies while the
 * Pin is still `from`, so of two racing moves one wins. `newer` is what remains newer than `to`.
 * Returns whether this call moved it.
 */
export async function movePin(
  env: Pick<Env, 'DB'>,
  skillId: string,
  from: string,
  to: FolderVersion,
  newer: FolderVersion[],
  kind: 'manual' | 'automatic',
  audits: Audits,
): Promise<boolean> {
  // The record is inserted first, while the Pin is still `from`; the batch is one transaction.
  const [recorded] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO skill_pin_move (id, skill_id, from_commit, to_commit, to_installed_hash, kind, audits, at)
       SELECT ?, id, pin_commit, ?, ?, ?, ?, ? FROM skill WHERE id = ? AND pin_commit = ?`,
    ).bind(crypto.randomUUID(), to.commit, to.installedHash, kind, JSON.stringify(storedAudits(audits)), Date.now(), skillId, from),
    env.DB.prepare(
      `UPDATE skill SET pin_commit = ?, pin_tree_sha = ?, pin_installed_hash = ?, pin_committed_at = ?, newer = ?,
       update_pushed_at = CASE WHEN ? THEN update_pushed_at ELSE NULL END
       WHERE id = ? AND pin_commit = ?`,
    ).bind(to.commit, to.treeSha, to.installedHash, to.committedAt, JSON.stringify(newer), newer.length ? 1 : 0, skillId, from),
  ]);
  return recorded!.meta.changes === 1;
}

/** Replace a Skill's assignment. Chosen Machines must be the user's own; others are left out. */
export async function setAssignment(env: Pick<Env, 'DB'>, userId: string, skillId: string, assignment: SkillAssignment) {
  const statements = [
    env.DB.prepare('UPDATE skill SET assignment = ? WHERE id = ? AND user_id = ?').bind(assignment.to, skillId, userId),
    env.DB.prepare('DELETE FROM skill_machine WHERE skill_id = ?').bind(skillId),
    ...(assignment.to === 'chosen' ? [...new Set(assignment.machineIds)] : []).map((machineId) =>
      env.DB.prepare(
        `INSERT INTO skill_machine (skill_id, machine_id)
         SELECT s.id, m.id FROM skill s, machine m WHERE s.id = ? AND s.user_id = ? AND m.id = ? AND m.user_id = ?`,
      ).bind(skillId, userId, machineId, userId)),
  ];
  await env.DB.batch(statements);
}

export async function setAutoUpdate(env: Pick<Env, 'DB'>, userId: string, skillId: string, autoUpdate: boolean) {
  await createDb(env).update(skill).set({ autoUpdate }).where(and(eq(skill.id, skillId), eq(skill.userId, userId))).run();
}

/** Delete a Skill and its history. Machines remove their copies on their next `skills sync`. */
export async function deleteSkill(env: Pick<Env, 'DB'>, userId: string, skillId: string) {
  const result = await createDb(env).delete(skill).where(and(eq(skill.id, skillId), eq(skill.userId, userId))).run();
  return result.meta.changes > 0; // D1 counts the cascaded rows too.
}

/**
 * What an update check found, saved only while the Pin is still `pinCommit`: a check that raced a Pin
 * move describes an old Pin, and its versions could include the new Pin's predecessors. Returns whether it saved.
 */
export async function saveCheck(
  env: Pick<Env, 'DB'>,
  skillId: string,
  pinCommit: string,
  check: { repoFullName: string; repoAliases: string[]; newer: FolderVersion[]; updatePushedAt: Date | null; audits: Audits | null },
): Promise<boolean> {
  const result = await createDb(env).update(skill).set({
    repoFullName: check.repoFullName, repoAliases: check.repoAliases, newer: check.newer, updatePushedAt: check.updatePushedAt,
    ...(check.audits ? { audits: storedAudits(check.audits) } : {}), checkedAt: new Date(),
  }).where(and(eq(skill.id, skillId), eq(skill.pinCommit, pinCommit))).run();
  return result.meta.changes === 1;
}

/** Mark a Skill as checked at `at` without changing what is known, e.g. after GitHub failed, so the cron moves on. */
export async function touchCheck(env: Pick<Env, 'DB'>, skillId: string, at = new Date()) {
  await createDb(env).update(skill).set({ checkedAt: at }).where(eq(skill.id, skillId)).run();
}

/** Skills of every user not checked since `before`, never-checked first. */
export function staleSkillRows(env: Pick<Env, 'DB'>, before: Date, limit: number): Promise<SkillRow[]> {
  return createDb(env).select().from(skill)
    .where(or(isNull(skill.checkedAt), lt(skill.checkedAt, before)))
    .orderBy(asc(skill.checkedAt)).limit(limit).all();
}

export function pinHistory(env: Pick<Env, 'DB'>, skillId: string) {
  return createDb(env).select().from(skillPinMove).where(eq(skillPinMove.skillId, skillId)).orderBy(desc(skillPinMove.at)).all();
}

export async function getSettings(env: Pick<Env, 'DB'>, userId: string) {
  const row = await createDb(env).select().from(skillSettings).where(eq(skillSettings.userId, userId)).get();
  return { autoUpdate: row?.autoUpdate ?? false };
}

export async function putSettings(env: Pick<Env, 'DB'>, userId: string, settings: { autoUpdate: boolean }) {
  await createDb(env).insert(skillSettings).values({ userId, ...settings })
    .onConflictDoUpdate({ target: skillSettings.userId, set: settings }).run();
  return settings;
}

export function listExclusions(env: Pick<Env, 'DB'>, userId: string) {
  return createDb(env).select({ repo: skillExclusion.repo, name: skillExclusion.name }).from(skillExclusion)
    .where(eq(skillExclusion.userId, userId)).orderBy(asc(skillExclusion.repo), asc(skillExclusion.name)).all();
}

/** Save which Found Skills are ignored. Skills already synced keep their pins, assignments and history. */
export async function setExclusions(env: Pick<Env, 'DB'>, userId: string, repo: string, names: string[], ignored: boolean) {
  const db = createDb(env);
  const source = repo.toLowerCase();
  const unique = [...new Set(names)];
  if (!unique.length) return;
  if (!ignored) {
    const remove = (names: string[]) => db.delete(skillExclusion).where(and(eq(skillExclusion.userId, userId), eq(skillExclusion.repo, source), inArray(skillExclusion.name, names)));
    // D1 allows at most 100 bound parameters per statement.
    const remaining = Array.from({ length: Math.ceil(unique.length / 90) - 1 }, (_, i) => unique.slice((i + 1) * 90, (i + 2) * 90));
    await db.batch([remove(unique.slice(0, 90)), ...remaining.map(remove)]);
    return;
  }
  const rows = await listSkillRows(env, userId);
  const managed = new Set(rows.filter((row) => [row.repoFullName.toLowerCase(), ...row.repoAliases].includes(source)).map((row) => row.name));
  const [first, ...rest] = unique.filter((name) => !managed.has(name));
  if (first === undefined) return;
  // One statement per exclusion avoids SQLite's bind limit for large collections.
  await db.batch([
    db.insert(skillExclusion).values({ userId, repo: source, name: first }).onConflictDoNothing(),
    ...rest.map((name) => db.insert(skillExclusion).values({ userId, repo: source, name }).onConflictDoNothing()),
  ]);
}

/** A folder's hashes at a commit, if a previous call fetched them. */
export function cachedFolderVersion(env: Pick<Env, 'DB'>, repoId: number, commit: string, path: string) {
  return createDb(env).select().from(skillFolderVersion)
    .where(and(eq(skillFolderVersion.repoId, repoId), eq(skillFolderVersion.commit, commit), eq(skillFolderVersion.path, path))).get();
}

/** Every cached version of a folder by commit, in one query however long its history is. */
export async function cachedVersionsOfFolder(env: Pick<Env, 'DB'>, repoId: number, path: string) {
  const rows = await createDb(env).select().from(skillFolderVersion)
    .where(and(eq(skillFolderVersion.repoId, repoId), eq(skillFolderVersion.path, path))).all();
  return new Map(rows.map((row) => [row.commit, row]));
}

/** The folders of a commit whose SKILL.md was already read, with what it said. */
export async function namedFolders(env: Pick<Env, 'DB'>, repoId: number, commit: string) {
  const rows = await createDb(env).select({ path: skillFolderVersion.path, skillName: skillFolderVersion.skillName, installedHash: skillFolderVersion.installedHash })
    .from(skillFolderVersion)
    .where(and(eq(skillFolderVersion.repoId, repoId), eq(skillFolderVersion.commit, commit), isNotNull(skillFolderVersion.skillName))).all();
  return new Map(rows.map((row) => [row.path, { skillName: row.skillName!, installedHash: row.installedHash }]));
}

/** Save folders read at a commit in one round trip, naming any that were cached without a name. */
export async function cacheNamedFolders(env: Pick<Env, 'DB'>, rows: (typeof skillFolderVersion.$inferInsert & { skillName: string })[]) {
  const db = createDb(env);
  const insert = (row: (typeof rows)[number]) => db.insert(skillFolderVersion).values(row)
    .onConflictDoUpdate({ target: [skillFolderVersion.repoId, skillFolderVersion.commit, skillFolderVersion.path], set: { skillName: row.skillName } });
  const [first, ...rest] = rows;
  if (first) await db.batch([insert(first), ...rest.map(insert)]);
}

/** Record which skill (`''`: none) a cached folder version holds, once its SKILL.md was read. */
export async function nameFolderVersion(env: Pick<Env, 'DB'>, repoId: number, commit: string, path: string, skillName: string) {
  await createDb(env).update(skillFolderVersion).set({ skillName })
    .where(and(eq(skillFolderVersion.repoId, repoId), eq(skillFolderVersion.commit, commit), eq(skillFolderVersion.path, path))).run();
}

export async function cacheFolderVersion(env: Pick<Env, 'DB'>, row: typeof skillFolderVersion.$inferInsert) {
  await createDb(env).insert(skillFolderVersion).values(row).onConflictDoNothing().run();
}

