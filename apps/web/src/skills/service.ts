import {
  RESERVED_SKILL_NAME, repoNameSchema, skillNameSchema,
  type Audits, type FoundSkill, type MachineSkillState, type Pin, type PinMove, type Skill, type SkillCandidate,
  type SkillDiff, type SkillsOverview, type DesiredSkill, type ScannedSkill, type SkillSyncResult, type SkillAssignment,
} from '@agentsync/contract';
import { countQueries } from '../db';
import {
  assignedSkillRows, cacheFolderVersion, cacheNamedFolders, cachedFolderVersion, cachedVersionsOfFolder, chosenMachines, deleteSkill, getReport, getSettings,
  auditsOf, getSkillRow, insertSkill, listSkillRows, movePin, namedFolders, nameFolderVersion, noAudits, storedAudits, pinHashes, pinHistory, putSettings, reportsFor, saveCheck,
  saveReport, setAssignment, setAutoUpdate, staleSkillRows, touchCheck, listExclusions, setExclusions, type SkillRow,
} from '../db/skills';
import { listMachines } from '../db/machines';
import type { FolderVersion } from '../db/schema';
import type { Env } from '../env';
import { isAudited, mayAutoUpdate } from './audits';
import { frontmatterName, skillFolders } from './discovery';
import { github, NotFoundError, UpstreamError, type Commit, type GitHub, type Repo, type Tree } from './github';
import { installedFolderHash, UnsupportedSkillFolder } from './hash';
import { fetchAudits, searchSkills } from './skillssh';
import { machineSkillState } from './status';

/** The name is taken in the account, or reserved. */
export class NameTakenError extends Error {}
/** A Machine's copy matches no version of the folder on the default branch. */
export class NoMatchingCommitError extends Error {}
/** The search for a skill's folder or version used up this request's budget. What it read is saved, so asking again gets further. */
class StillReadingError extends UnsupportedSkillFolder {}
const STILL_READING = 'AgentSync hasn’t finished reading this repository. Try again.';

/** The contract's name for a failed Skills call, or `null` if it's a bug rather than an expected failure. */
export function skillFailure(error: unknown) {
  if (error instanceof NotFoundError) return { code: 'NOT_FOUND' } as const;
  if (error instanceof UnsupportedSkillFolder) return { code: 'UNSUPPORTED_SKILL', reason: error.message } as const;
  if (error instanceof NameTakenError) return { code: 'SKILL_NAME_TAKEN' } as const;
  if (error instanceof NoMatchingCommitError) return { code: 'NO_MATCHING_COMMIT' } as const;
  if (error instanceof UpstreamError) return { code: 'UPSTREAM_UNAVAILABLE' } as const;
  return null;
}

/** How many versions of a folder one check looks at (two GitHub requests each, unless cached). */
const MAX_VERSIONS = 5;
/** The most requests one update check makes: repository, history, a tree and a SKILL.md per version, audits. */
export const CHECK_REQUESTS = 3 + 2 * MAX_VERSIONS;
/** Requests an Add may have made and still look for newer versions (up to 2 × MAX_VERSIONS more), under a Worker's 50. */
const ADD_REQUEST_BUDGET = 50 - 2 * MAX_VERSIONS - 2;
/** Requests after which no more SKILL.md files or old versions are read, or skills started, leaving room for the rest of an Add. */
const READ_BUDGET = ADD_REQUEST_BUDGET - 2;
/** The D1 statements a Worker invocation may make on the Free plan. */
const QUERY_LIMIT = 50;
/** D1 statements after which the same stops: finishing the skill in hand takes up to 20 more. */
const QUERY_BUDGET = QUERY_LIMIT - 20;
/**
 * The most D1 statements one update check makes: settings, cached versions, an insert and a name per
 * version, saving the check, moving the Pin (a batch of 2), and recording a failure.
 */
const CHECK_QUERIES = 2 + 2 * MAX_VERSIONS + 1 + 2 + 1;
/** How many SKILL.md files are read at once. */
const READ_AT_ONCE = 6;

/** A repository at one commit, read once however many of its skills are looked up. */
interface RepoSnapshot {
  repo: Repo;
  commit: string;
  tree: Tree;
  /** Every folder that may hold a skill, in the order `skills` walks them. */
  folders: string[];
  /** What each folder's SKILL.md said at this commit, for those read so far. */
  named: Awaited<ReturnType<typeof namedFolders>>;
}
/** A repository at its newest commit. */
interface RepoHead extends RepoSnapshot {
  head: Commit;
}

/** Every `owner/repo` a Machine's lock may record for a Skill's repository, lowercase. */
const sourcesOf = (row: Pick<SkillRow, 'repoFullName' | 'repoAliases'>) =>
  [...new Set([row.repoFullName.toLowerCase(), ...row.repoAliases])];

const toPin = (version: FolderVersion): Pin => ({
  commit: version.commit, treeSha: version.treeSha, installedHash: version.installedHash, committedAt: new Date(version.committedAt),
});
const pinOf = (row: SkillRow): FolderVersion => ({
  commit: row.pinCommit, treeSha: row.pinTreeSha, installedHash: row.pinInstalledHash, committedAt: row.pinCommittedAt.getTime(),
});

/** Skills: adding, pinning and updating them from GitHub, and where they stand on each Machine. */
export function skillsService(worker: Env) {
  const { env, usage: db } = countQueries(worker);
  const gh: GitHub = github(env.GITHUB_TOKEN);
  const outOfBudget = () => gh.usage.requests >= READ_BUDGET || db.queries > QUERY_BUDGET;
  /** skills.sh verdicts. One outgoing request, which counts against the budget like GitHub's, even if it fails. */
  const auditsOfSkills = (fullName: string, names: string[]) => {
    gh.usage.requests++;
    return fetchAudits(fullName, names);
  };

  /**
   * A folder at a commit, from the D1 cache or GitHub: its hashes (one tree call), and with `name` also
   * checked to still be the skill of that name there (one raw read), so a version that lost or renamed
   * its SKILL.md is never offered. `null` if it isn't an installable version of `name` (with `name`
   * `null`: of any skill, to compare hashes before paying for the name check). `known` is the folder's
   * cached versions (see `cachedVersionsOfFolder`), to save a query per version when looking through many.
   */
  async function folderVersion(repoId: number, fullName: string, commit: Commit, path: string, name: string | null, known?: Awaited<ReturnType<typeof cachedVersionsOfFolder>>): Promise<FolderVersion | null> {
    let cached = known ? known.get(commit.sha) : await cachedFolderVersion(env, repoId, commit.sha, path);
    if (!cached) {
      let tree: Awaited<ReturnType<GitHub['tree']>>;
      try {
        tree = await gh.tree(fullName, commit.sha, path);
      } catch (error) {
        // The commit deleted or moved the folder: a version with no skill in it.
        if (!(error instanceof NotFoundError)) throw error;
        const missing = { repoId, commit: commit.sha, path, treeSha: '', installedHash: null, skillName: '' };
        await cacheFolderVersion(env, missing);
        known?.set(commit.sha, missing);
        return null;
      }
      let installedHash: string | null = null;
      if (!tree.truncated && tree.tree.some((item) => item.path === 'SKILL.md' && item.type === 'blob')) {
        try {
          installedHash = await installedFolderHash(tree.tree, '');
        } catch (error) {
          if (!(error instanceof UnsupportedSkillFolder)) throw error;
        }
      }
      // Without an installable folder the name doesn't matter: record it as having none.
      cached = { repoId, commit: commit.sha, path, treeSha: tree.sha, installedHash, skillName: installedHash ? null : '' };
      await cacheFolderVersion(env, cached);
      known?.set(commit.sha, cached);
    }
    if (!cached.installedHash) return null;
    if (name !== null && cached.skillName === null) {
      const text = await gh.raw(fullName, commit.sha, path ? `${path}/SKILL.md` : 'SKILL.md');
      cached.skillName = (text === null ? null : frontmatterName(text)) ?? '';
      await nameFolderVersion(env, repoId, commit.sha, path, cached.skillName);
    }
    if (name !== null && cached.skillName !== name) return null;
    return { commit: commit.sha, treeSha: cached.treeSha, installedHash: cached.installedHash, committedAt: commit.committedAt.getTime() };
  }

  /** The repository, refusing private ones. */
  async function publicRepo(name: string): Promise<Repo> {
    const repo = await gh.repo(name);
    if (repo.private) throw new UnsupportedSkillFolder('The repository is private.');
    return repo;
  }

  /** A repository at `commit`: 1 GitHub call, plus up to 2 for plugin manifests. */
  async function readSnapshot(repo: Repo, commit: string): Promise<RepoSnapshot> {
    const tree = await gh.tree(repo.fullName, commit);
    if (tree.truncated) throw new UnsupportedSkillFolder('The repository is too large to search.');
    const [folders, named] = await Promise.all([
      skillFolders(tree.tree, (path) => gh.raw(repo.fullName, commit, path)),
      namedFolders(env, repo.id, commit),
    ]);
    return { repo, commit, tree, folders, named };
  }

  /** A repository as it is now: 2 GitHub calls more than a snapshot. */
  async function readHead(repoName: string): Promise<RepoHead> {
    const repo = await publicRepo(repoName);
    const head = await gh.commit(repo.fullName, repo.defaultBranch);
    return { ...await readSnapshot(repo, head.sha), head };
  }

  /**
   * Read these folders' SKILL.md and save what they say, so no later call has to read them again. A folder
   * that can't be read doesn't lose the others: returns why, by folder, for the caller to raise if it matters.
   */
  async function readFolders({ repo, commit, tree, named }: RepoSnapshot, folders: string[]) {
    const results = await Promise.allSettled(folders.map(async (folder) => {
      const text = await gh.raw(repo.fullName, commit, folder ? `${folder}/SKILL.md` : 'SKILL.md');
      let installedHash: string | null = null;
      try {
        installedHash = await installedFolderHash(tree.tree, folder);
      } catch (error) {
        if (!(error instanceof UnsupportedSkillFolder)) throw error;
      }
      return {
        repoId: repo.id, commit, path: folder, installedHash, skillName: (text === null ? null : frontmatterName(text)) ?? '',
        treeSha: folder ? tree.tree.find((item) => item.path === folder)!.sha : tree.sha,
      };
    }));
    const rows = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    await cacheNamedFolders(env, rows);
    for (const row of rows) named.set(row.path, row);
    return new Map(results.flatMap((result, index): [string, unknown][] => result.status === 'rejected' ? [[folders[index]!, result.reason]] : []));
  }

  /**
   * The folder of the skill named `name`, or `null`: the first in `skills`' own walk order whose SKILL.md
   * declares exactly that name, since `skills` keeps the first skill of a name and drops later ones.
   */
  async function findFolder(at: RepoHead, name: string): Promise<string | null> {
    for (const [index, folder] of at.folders.entries()) {
      if (!at.named.has(folder)) {
        const room = READ_BUDGET - gh.usage.requests;
        if (outOfBudget()) throw new StillReadingError(STILL_READING);
        const failures = await readFolders(at, at.folders.slice(index).filter((later) => !at.named.has(later)).slice(0, Math.min(room, READ_AT_ONCE)));
        // Only this folder decides the search: a later one read ahead may never be reached.
        if (failures.has(folder)) throw failures.get(folder);
      }
      if (at.named.get(folder)!.skillName === name) return folder;
    }
    return null;
  }

  /** The newest version of the skill `name` in a repository, found the way `skills add` finds it, plus the folder's history at the head. */
  async function resolveLatest(at: RepoHead, name: string) {
    const { repo, head, tree } = at;
    const path = await findFolder(at, name);
    if (path === null) throw new NotFoundError(`${repo.fullName} has no skill named ${name}.`);
    if (path.length > 500) throw new UnsupportedSkillFolder('The skill’s folder path is too long.');
    const history = await gh.folderHistory(repo.fullName, head.sha, path);
    // The folder at HEAD is the folder at its newest change, which is what a Pin names.
    const latest = history[0] ?? head;
    const treeSha = path ? tree.tree.find((item) => item.path === path)?.sha : tree.sha;
    const installedHash = await installedFolderHash(tree.tree, path);
    await cacheFolderVersion(env, { repoId: repo.id, commit: latest.sha, path, treeSha: treeSha!, installedHash, skillName: name });
    const version: FolderVersion = { commit: latest.sha, treeSha: treeSha!, installedHash, committedAt: latest.committedAt.getTime() };
    return { repo, path, version, history };
  }

  /**
   * The installable versions of a folder newer than `pinCommit`, newest first, from its history on the
   * default branch. `newestUsable` is false when the newest change is not one of them (it dropped the
   * skill, renamed it, or added a symlink): then nothing may update automatically, because the audits
   * describe that newest content, not an older version that is still installable.
   */
  async function versionsAfter(repo: Repo, path: string, name: string, pinCommit: string, history?: Commit[]) {
    const commits = history ?? await gh.folderHistory(repo.fullName, repo.defaultBranch, path);
    const index = commits.findIndex((commit) => commit.sha === pinCommit);
    const candidates = (index < 0 ? commits : commits.slice(0, index)).slice(0, MAX_VERSIONS);
    const known = await cachedVersionsOfFolder(env, repo.id, path);
    // Wait for all of them even if one fails: the rest keep making requests and writes, which the budget must see.
    const versions = await Promise.allSettled(candidates.map((commit) => folderVersion(repo.id, repo.fullName, commit, path, name, known)));
    const failed = versions.find((version) => version.status === 'rejected');
    if (failed) throw failed.reason;
    const newer = versions.flatMap((version) => version.status === 'fulfilled' && version.value ? [version.value] : []);
    return { newer, newestUsable: !candidates.length || newer[0]?.commit === candidates[0]!.sha };
  }

  /**
   * Check a Skill for newer versions and fresh audits, and save what was found, unless the Pin moved
   * meanwhile (then the result describes an old Pin and is dropped). With automatic updates on (and the
   * Skill not ignored), move the Pin to the newest version if the hold-back rule allows it.
   */
  async function checkSkill(row: SkillRow, autoUpdate?: boolean): Promise<SkillRow> {
    const repo = await gh.repoById(row.repoId);
    if (repo.private) {
      await touchCheck(env, row.id);
      return row;
    }
    const { newer, newestUsable } = await versionsAfter(repo, row.path, row.name, row.pinCommit);
    let audits: Audits | null = null;
    try {
      audits = (await auditsOfSkills(repo.fullName, [row.name])).get(row.name) ?? null;
    } catch {
      // skills.sh is down: keep the verdicts we have.
    }
    const sameCandidate = newer[0]?.commit === row.newer[0]?.commit;
    // `null` makes the update "not audited": no push time to compare verdicts with, or not the newest version.
    const updatePushedAt = !newer.length || !newestUsable ? null : sameCandidate && row.updatePushedAt ? row.updatePushedAt : repo.pushedAt;
    // A rename since the last check: Machines' locks may still say the old name.
    const renamed = repo.fullName.toLowerCase() !== row.repoFullName.toLowerCase();
    const repoAliases = renamed ? [...new Set([...row.repoAliases, row.repoFullName.toLowerCase()])] : row.repoAliases;
    const saved = await saveCheck(env, row.id, row.pinCommit, { repoFullName: repo.fullName, repoAliases, newer, updatePushedAt, audits });
    if (!saved) return (await getSkillRow(env, row.userId, row.id)) ?? row;
    const latest = audits ?? auditsOf(row.audits);
    const checked: SkillRow = { ...row, repoFullName: repo.fullName, repoAliases, newer, updatePushedAt, audits: storedAudits(latest), checkedAt: new Date() };
    const allowed = autoUpdate ?? (await getSettings(env, row.userId)).autoUpdate;
    const candidate = newer[0];
    if (allowed && row.autoUpdate && candidate && mayAutoUpdate(latest, updatePushedAt)) {
      if (await movePin(env, row.id, row.pinCommit, candidate, [], 'automatic', latest)) {
        return { ...checked, ...pinColumns(candidate), newer: [], updatePushedAt: null };
      }
    }
    return checked;
  }

  /**
   * Add a Skill from a repository already read. With `machineId`, pin the version that Machine already
   * has (a Found Skill), so nothing is reinstalled: only a version from the default branch's own history counts.
   */
  async function addAt(userId: string, at: RepoHead, input: { repo: string; name: string; machineId?: string | undefined }, audits: Audits | null): Promise<SkillRow> {
    if (input.name === RESERVED_SKILL_NAME) throw new NameTakenError(`"${RESERVED_SKILL_NAME}" is the CLI's own skill.`);
    const { repo, path, version: latest, history } = await resolveLatest(at, input.name);
    let pin = latest;
    if (input.machineId !== undefined) {
      const machines = await listMachines(env, userId);
      if (!machines.some((machine) => machine.id === input.machineId)) throw new NotFoundError('No such Machine.');
      const hash = (await getReport(env, input.machineId))?.scan.find((item) => item.name === input.name && !item.managed)?.hash;
      if (!hash) throw new NoMatchingCommitError('That Machine has no copy of this skill from GitHub.');
      const known = await cachedVersionsOfFolder(env, repo.id, path);
      let match: FolderVersion | null = null;
      for (const commit of history) {
        if (outOfBudget()) throw new StillReadingError(STILL_READING);
        const version = commit.sha === latest.commit ? latest : await folderVersion(repo.id, repo.fullName, commit, path, null, known);
        if (version?.installedHash === hash) {
          // Only a version that still is this skill counts.
          match = version === latest ? latest : await folderVersion(repo.id, repo.fullName, commit, path, input.name, known);
          break;
        }
      }
      if (!match) throw new NoMatchingCommitError('The copy on that Machine matches no version on the default branch.');
      pin = match;
    }
    const verdicts = audits ?? noAudits;
    // The name asked for may be an old one that GitHub redirected: a Machine's lock may still say it.
    const aliases = input.repo.toLowerCase() === repo.fullName.toLowerCase() ? [] : [input.repo.toLowerCase()];
    const row = await insertSkill(env, { userId, name: input.name, repo: { id: repo.id, fullName: repo.fullName }, aliases, path, pin, audits: verdicts });
    if (!row) throw new NameTakenError(`A Skill named ${input.name} is already in the account.`);
    // An explicit Add restores a previously excluded skill, including an old repository alias.
    for (const source of new Set([input.repo, repo.fullName])) {
      await setExclusions(env, userId, source, [input.name], false);
    }
    if (pin === latest) return row;
    // Near a Worker request's limit, leave the newer versions to the next update check (soon: never checked).
    if (gh.usage.requests > ADD_REQUEST_BUDGET || db.queries > QUERY_BUDGET) return row;
    try {
      const { newer, newestUsable } = await versionsAfter(repo, path, input.name, pin.commit, history);
      const updatePushedAt = newer.length && newestUsable ? repo.pushedAt : null;
      if (newer.length && await saveCheck(env, row.id, pin.commit, { repoFullName: repo.fullName, repoAliases: aliases, newer, updatePushedAt, audits: verdicts })) {
        return { ...row, newer, updatePushedAt };
      }
    } catch (error) {
      // The Skill is saved, so this isn't a failed Add: the next update check looks again.
      if (!(error instanceof UpstreamError)) throw error;
    }
    return row;
  }

  const pinColumns = (version: FolderVersion) => ({
    pinCommit: version.commit, pinTreeSha: version.treeSha, pinInstalledHash: version.installedHash, pinCommittedAt: new Date(version.committedAt),
  });

  /** A Skill row with everything the dashboard shows about it. */
  async function present(rows: SkillRow[], userId: string): Promise<{ skills: Skill[]; reports: Awaited<ReturnType<typeof reportsFor>>; machines: Awaited<ReturnType<typeof listMachines>> }> {
    const ids = rows.map((row) => row.id);
    const [machines, reports, chosen, hashes] = await Promise.all([
      listMachines(env, userId), reportsFor(env, userId), chosenMachines(env, ids), pinHashes(env, ids),
    ]);
    const skills = rows.map((row): Skill => {
      const chosenHere = new Set(chosen.get(row.id) ?? []);
      const assignment: SkillAssignment = row.assignment === 'all' ? { to: 'all' } : { to: 'chosen', machineIds: [...chosenHere] };
      const olderHashes = new Set([...(hashes.get(row.id) ?? [])].filter((hash) => hash !== row.pinInstalledHash));
      const newer = row.newer.map((version) => ({ ...version, committedAt: new Date(version.committedAt) }));
      const audits = auditsOf(row.audits);
      const candidate = row.newer[0];
      return {
        id: row.id,
        name: row.name,
        repo: { id: row.repoId, fullName: row.repoFullName },
        path: row.path,
        pin: toPin(pinOf(row)),
        assignment,
        autoUpdate: row.autoUpdate,
        update: candidate ? { pin: toPin(candidate), audits, audited: isAudited(audits, row.updatePushedAt) } : null,
        machines: machines.map((machine): MachineSkillState & { machineId: string } => {
          const report = reports.get(machine.id);
          return {
            machineId: machine.id,
            ...machineSkillState({
              assigned: row.assignment === 'all' || chosenHere.has(machine.id),
              pin: { commit: row.pinCommit, installedHash: row.pinInstalledHash },
              sources: sourcesOf(row),
              olderHashes,
              newer,
              scanned: report?.scan.find((item) => item.name === row.name),
              result: report?.results?.find((result) => result.name === row.name),
              syncedAt: report?.syncedAt ?? null,
            }),
          };
        }),
        createdAt: row.createdAt,
      };
    });
    return { skills, reports, machines };
  }

  async function presentOne(row: SkillRow): Promise<Skill> {
    return (await present([row], row.userId)).skills[0]!;
  }

  async function ownSkill(userId: string, skillId: string): Promise<SkillRow> {
    const row = await getSkillRow(env, userId, skillId);
    if (!row) throw new NotFoundError('No such Skill.');
    return row;
  }

  return {
    async overview(userId: string): Promise<SkillsOverview> {
      const [rows, settings, ignored] = await Promise.all([listSkillRows(env, userId), getSettings(env, userId), listExclusions(env, userId)]);
      const { skills, reports, machines } = await present(rows, userId);
      const names = new Set(rows.map((row) => row.name));
      const github = new Map<string, Extract<FoundSkill, { kind: 'github' }>>();
      const local = new Map<string, Extract<FoundSkill, { kind: 'local' }>>();
      for (const machine of machines) {
        for (const item of reports.get(machine.id)?.scan ?? []) {
          if (item.managed || names.has(item.name) || item.name === RESERVED_SKILL_NAME) continue;
          const name = skillNameSchema.safeParse(item.name);
          const source = repoNameSchema.safeParse(item.source);
          if (name.success && source.success) {
            const key = `${name.data} ${source.data.toLowerCase()}`;
            const found = github.get(key) ?? { kind: 'github' as const, name: name.data, source: source.data, machines: [] };
            found.machines.push({ machineId: machine.id, ref: item.ref && /^[0-9a-f]{40}$/.test(item.ref) ? item.ref : null });
            github.set(key, found);
          } else {
            const found = local.get(item.name) ?? { kind: 'local' as const, name: item.name, machineIds: [] };
            found.machineIds.push(machine.id);
            local.set(item.name, found);
          }
        }
      }
      return {
        settings,
        skills,
        ignored,
        found: [...github.values(), ...local.values()],
        machines: machines.map((machine) => ({
          id: machine.id, nickname: machine.nickname, checkedInAt: reports.get(machine.id)?.reportedAt ?? null,
        })),
      };
    },

    search: (query: string) => searchSkills(query),

    async collection(input: { repo: string; offset: number; commit?: string | undefined }) {
      const repo = await publicRepo(input.repo);
      const at = await readSnapshot(repo, input.commit ?? (await gh.commit(repo.fullName, repo.defaultBranch)).sha);
      const page = at.folders.slice(input.offset, input.offset + 20);
      const [failure] = (await readFolders(at, page.filter((folder) => !at.named.has(folder)))).values();
      if (failure) throw failure;
      const names = page.flatMap((folder) => {
        const { skillName, installedHash } = at.named.get(folder)!;
        const name = skillNameSchema.safeParse(skillName);
        return installedHash && name.success && name.data !== RESERVED_SKILL_NAME ? [name.data] : [];
      });
      const next = input.offset + page.length;
      return { repo: repo.fullName, commit: at.commit, names: [...new Set(names)], next: next < at.folders.length ? next : null };
    },

    setIgnored: (userId: string, repo: string, names: string[], ignored: boolean) => setExclusions(env, userId, repo, names, ignored),

    /** Verdicts are keyed by the repository's name on skills.sh, so ask under its current one: an old name returns frozen ones. */
    async audits(repoName: string, names: string[]) {
      const repo = await publicRepo(repoName);
      const verdicts = await auditsOfSkills(repo.fullName, names);
      return names.map((name) => ({ name, audits: verdicts.get(name) ?? noAudits }));
    },

    async inspect(repoName: string, name: string): Promise<SkillCandidate> {
      const { repo, path, version } = await resolveLatest(await readHead(repoName), name);
      const audits = (await auditsOfSkills(repo.fullName, [name]).catch(() => null))?.get(name) ?? noAudits;
      return { name, repo: { id: repo.id, fullName: repo.fullName }, path, pin: toPin(version), audits };
    },

    /** Add a Skill from GitHub. See `addAt`. */
    async add(userId: string, input: { repo: string; name: string; machineId?: string | undefined }): Promise<Skill> {
      const at = await readHead(input.repo);
      const audits = (await auditsOfSkills(at.repo.fullName, [input.name]).catch(() => null))?.get(input.name) ?? null;
      return presentOne(await addAt(userId, at, input, audits));
    },

    /** Add several skills of a repository, sharing what one read of it found. See `addMany` in the contract. */
    async addMany(userId: string, input: { repo: string; skills: { name: string; machineId?: string | undefined }[] }) {
      const at = await readHead(input.repo);
      const names = input.skills.map((skill) => skill.name);
      const audits = await auditsOfSkills(at.repo.fullName, names).catch(() => null);
      const added: string[] = [];
      const failed: ({ name: string } & NonNullable<ReturnType<typeof skillFailure>>)[] = [];
      for (const [index, skill] of input.skills.entries()) {
        if (index && outOfBudget()) return { added, failed, rest: names.slice(index) };
        try {
          await addAt(userId, at, { repo: input.repo, ...skill }, audits?.get(skill.name) ?? null);
          added.push(skill.name);
        } catch (error) {
          if (error instanceof StillReadingError) return { added, failed, rest: names.slice(index) };
          const failure = skillFailure(error);
          if (!failure) throw error;
          console.warn(`Couldn't add ${skill.name} from ${input.repo}: ${failure.code}: ${(error as Error).message}`);
          failed.push({ name: skill.name, ...failure });
          if (failure.code === 'UPSTREAM_UNAVAILABLE') return { added, failed, rest: names.slice(index + 1) };
        }
      }
      return { added, failed, rest: [] };
    },

    async assign(userId: string, skillId: string, assignment: SkillAssignment) {
      await ownSkill(userId, skillId);
      await setAssignment(env, userId, skillId, assignment);
      return presentOne(await ownSkill(userId, skillId));
    },

    /** Move the Pin to `commit`: a newer version the last check found, or finds now. */
    async update(userId: string, skillId: string, commit: string): Promise<Skill> {
      let row = await ownSkill(userId, skillId);
      if (row.pinCommit === commit) return presentOne(row);
      if (!row.newer.some((version) => version.commit === commit)) row = await checkSkill(row, false);
      const index = row.newer.findIndex((version) => version.commit === commit);
      if (index < 0) throw new NotFoundError('That commit is not a newer version of this Skill on the default branch.');
      await movePin(env, row.id, row.pinCommit, row.newer[index]!, row.newer.slice(0, index), 'manual', auditsOf(row.audits));
      return presentOne(await ownSkill(userId, skillId));
    },

    async updateAll(userId: string) {
      let updated = 0;
      for (const row of await listSkillRows(env, userId)) {
        const candidate = row.newer[0];
        if (candidate && await movePin(env, row.id, row.pinCommit, candidate, [], 'manual', auditsOf(row.audits))) updated++;
      }
      return { updated };
    },

    async remove(userId: string, skillId: string) {
      if (!await deleteSkill(env, userId, skillId)) throw new NotFoundError('No such Skill.');
    },

    async setAutoUpdate(userId: string, skillId: string, autoUpdate: boolean) {
      await ownSkill(userId, skillId);
      await setAutoUpdate(env, userId, skillId, autoUpdate);
      return presentOne(await ownSkill(userId, skillId));
    },

    settings: (userId: string, settings: { autoUpdate: boolean }) => putSettings(env, userId, settings),

    async history(userId: string, skillId: string): Promise<PinMove[]> {
      await ownSkill(userId, skillId);
      return (await pinHistory(env, skillId)).map((move) => ({
        from: move.fromCommit, to: move.toCommit, kind: move.kind, audits: auditsOf(move.audits), at: move.at,
      }));
    },

    /** The files that changed in the Skill's folder between `base` (default: the Pin) and `head` (default: the update candidate). */
    async diff(userId: string, skillId: string, base?: string, head?: string): Promise<SkillDiff> {
      const row = await ownSkill(userId, skillId);
      const from = base ?? row.pinCommit;
      const to = head ?? row.newer[0]?.commit;
      if (!to) throw new NotFoundError('This Skill has no update to compare with.');
      const files = await gh.compare(row.repoFullName, from, to);
      const prefix = row.path ? `${row.path}/` : '';
      return {
        base: from,
        head: to,
        truncated: files.length >= 300,
        files: files.filter((file) => file.filename.startsWith(prefix)).map((file) => ({
          path: file.filename.slice(prefix.length), status: file.status, additions: file.additions, deletions: file.deletions,
          ...(file.patch === undefined ? {} : { patch: file.patch }),
        })),
      };
    },

    /** The Skills a Machine should have, for `machines.sync`. */
    async desired(userId: string, machineId: string): Promise<DesiredSkill[]> {
      return (await assignedSkillRows(env, userId, machineId)).map((row) => ({
        name: row.name, repo: row.repoFullName, commit: row.pinCommit, installedHash: row.pinInstalledHash, sources: sourcesOf(row),
      }));
    },

    report: (machineId: string, scan: ScannedSkill[], results?: SkillSyncResult[]) => saveReport(env, machineId, scan, results),

    /**
     * The scheduled update check: Skills not checked for about a day, oldest first, as many as fit in
     * `budget` outgoing requests and a Worker's D1 limit. One check makes at most `CHECK_REQUESTS` and
     * `CHECK_QUERIES`. A failed check is retried in about two hours, not a day.
     */
    async checkStale(budget: number, now = new Date()) {
      const rows = await staleSkillRows(env, new Date(now.getTime() - 20 * 60 * 60 * 1000), 50);
      const settings = new Map<string, boolean>();
      let checked = 0;
      for (const row of rows) {
        if (gh.usage.requests + CHECK_REQUESTS > budget || db.queries + CHECK_QUERIES > QUERY_LIMIT) break;
        try {
          if (!settings.has(row.userId)) settings.set(row.userId, (await getSettings(env, row.userId)).autoUpdate);
          await checkSkill(row, settings.get(row.userId));
          checked++;
        } catch (error) {
          console.error(`[skills] check of ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
          await touchCheck(env, row.id, new Date(now.getTime() - 18 * 60 * 60 * 1000));
        }
      }
      return { checked, stale: rows.length };
    },
  };
}

export type SkillsService = ReturnType<typeof skillsService>;
