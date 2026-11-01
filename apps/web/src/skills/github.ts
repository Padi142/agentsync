import { repoNameSchema } from '@agentsync/contract';
import { UnsupportedSkillFolder, type GitTreeItem } from './hash';

/** GitHub or skills.sh did not answer in time, failed, or GitHub's rate limit is used up. */
export class UpstreamError extends Error {}
/** The repository, commit or path does not exist (or the repository is private). */
export class NotFoundError extends Error {}

const TIMEOUT_MS = 10_000;

export interface Repo {
  /** GitHub's ID: it stays the same when the repository is renamed. */
  id: number;
  /** The canonical `owner/repo` now, after any rename. */
  fullName: string;
  defaultBranch: string;
  pushedAt: Date;
  private: boolean;
}

export interface Commit {
  sha: string;
  committedAt: Date;
}

export interface Tree {
  /** The tree's own SHA. */
  sha: string;
  tree: GitTreeItem[];
  truncated: boolean;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * A read-only client for GitHub's public REST API and raw files. `token` is the `GITHUB_TOKEN` secret:
 * without one GitHub allows 60 requests an hour per IP. Every call has a timeout.
 */
export function github(token: string | undefined) {
  /** Requests made so far, API and raw: a Worker invocation may only make so many. */
  const usage = { requests: 0 };

  async function api<T>(path: string): Promise<T> {
    let response: Response;
    usage.requests++;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'agentsync',
          'x-github-api-version': '2022-11-28',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError(`GitHub did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404 || response.status === 422) throw new NotFoundError(`GitHub has no ${path}.`);
    if (!response.ok) {
      const limited = response.headers.get('x-ratelimit-remaining') === '0';
      throw new UpstreamError(limited ? 'GitHub’s rate limit is used up. Try again later.' : `GitHub answered ${response.status}.`);
    }
    return response.json() as Promise<T>;
  }

  async function repo(path: string): Promise<Repo> {
    const found = await api<{ id: number; full_name: string; default_branch: string; pushed_at: string; private: boolean }>(path);
    // GitHub's own name is checked like a person's: one that could be read as a flag never gets stored.
    if (!repoNameSchema.safeParse(found.full_name).success) {
      throw new UnsupportedSkillFolder(`AgentSync can't use the repository name ${found.full_name}.`);
    }
    return { id: found.id, fullName: found.full_name, defaultBranch: found.default_branch, pushedAt: new Date(found.pushed_at), private: found.private };
  }

  return {
    usage,
    /** A repository by name. GitHub follows a rename to the canonical name. */
    repo: (fullName: string) => repo(`/repos/${fullName}`),
    /** A repository by GitHub's ID, whatever it is called now. */
    repoById: (id: number) => repo(`/repositories/${id}`),

    /** The commit a branch, tag or SHA points to. */
    async commit(fullName: string, ref: string): Promise<Commit> {
      const commit = await api<{ sha: string; commit: { committer: { date: string } } }>(
        `/repos/${fullName}/commits/${encodeURIComponent(ref)}`,
      );
      return { sha: commit.sha, committedAt: new Date(commit.commit.committer.date) };
    },

    /** Every path under the root (or under `path`) at `commit`, recursively. */
    tree(fullName: string, commit: string, path = ''): Promise<Tree> {
      const ref = path ? `${commit}:${encodePath(path)}` : commit;
      return api<Tree>(`/repos/${fullName}/git/trees/${ref}?recursive=1`);
    },

    /**
     * The commits reachable from `ref` (a branch, or a SHA already read from it) that changed `path`
     * (the whole repository for `''`), newest first: the versions of a folder. Only that history, so a
     * commit from a fork never shows up here.
     */
    async folderHistory(fullName: string, ref: string, path: string): Promise<Commit[]> {
      const query = new URLSearchParams({ sha: ref, per_page: '100', ...(path ? { path } : {}) });
      const commits = await api<{ sha: string; commit: { committer: { date: string } } }[]>(`/repos/${fullName}/commits?${query}`);
      return commits.map((commit) => ({ sha: commit.sha, committedAt: new Date(commit.commit.committer.date) }));
    },

    /** The files that changed between two commits. GitHub lists at most 300. */
    async compare(fullName: string, base: string, head: string): Promise<FileChange[]> {
      const result = await api<{ files?: FileChange[] }>(`/repos/${fullName}/compare/${base}...${head}`);
      return result.files ?? [];
    },

    /** A file's text at a commit from raw.githubusercontent.com (no API quota), or `null` if missing. */
    async raw(fullName: string, commit: string, path: string): Promise<string | null> {
      let response: Response;
      usage.requests++;
      try {
        response = await fetch(`https://raw.githubusercontent.com/${fullName}/${commit}/${encodePath(path)}`, {
          headers: { 'user-agent': 'agentsync' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new UpstreamError(`GitHub did not answer: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new UpstreamError(`GitHub answered ${response.status}.`);
      return response.text();
    },
  };
}

export type GitHub = ReturnType<typeof github>;
