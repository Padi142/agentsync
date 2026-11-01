import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuditRisk } from '@agentsync/contract';
import { installedFolderHash, type GitTreeItem } from '../src/skills/hash';

type Files = Record<string, string | { link: string } | null>;

/**
 * A fake of GitHub's REST API, raw.githubusercontent.com and skills.sh audits behind `fetch`, serving
 * real git repositories built in a temporary directory, so tree hashes and folder histories are git's own.
 */
export function fakeGitHub() {
  const repos = new Map<string, { id: number; dir: string; private: boolean; pushedAt: Date }>();
  const audits = new Map<string, Record<string, { risk: AuditRisk; analyzedAt: Date }>>();
  let nextId = 100;
  const calls: string[] = [];
  /** Old names, which GitHub redirects to the renamed repository. */
  const renamed = new Map<string, string>();

  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();

  const realFetch = globalThis.fetch;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const lsTree = (dir: string, ref: string) => git(dir, 'ls-tree', '-r', '-t', ref).split('\n').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, type, sha] = meta!.split(' ');
    return { path, mode, type, sha };
  });
  const commitJson = (dir: string, sha: string) => ({ sha, commit: { committer: { date: git(dir, 'show', '-s', '--format=%cI', sha) } } });

  // A plain wrapper, not `vi.spyOn`: vitest reuses an existing spy, so stacking on the WorkOS fake would recurse.
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'www.skills.sh' && url.pathname === '/tele/audit') {
      const verdicts = audits.get(url.searchParams.get('source')!) ?? {};
      const body: Record<string, unknown> = {};
      for (const name of url.searchParams.get('skills')!.split(',')) {
        const verdict = verdicts[name];
        if (verdict) {
          const entry = { risk: verdict.risk, analyzedAt: verdict.analyzedAt.toISOString() };
          body[name] = { ath: entry, socket: { ...entry, alerts: 0, score: 90 }, snyk: entry };
        }
      }
      return json(body);
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      const [, owner, name, sha, ...path] = url.pathname.split('/');
      const repo = repos.get(`${owner}/${name}`);
      try {
        return new Response(git(repo!.dir, 'show', `${sha}:${decodeURIComponent(path.join('/'))}`));
      } catch {
        return new Response('404', { status: 404 });
      }
    }
    if (url.hostname !== 'api.github.com') return realFetch(input, init);
    calls.push(url.pathname + url.search);
    const byId = url.pathname.match(/^\/repositories\/(\d+)$/);
    const match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(.*)$/);
    const entry = byId
      ? [...repos.entries()].find(([, repo]) => repo.id === Number(byId[1]))
      : match && [...repos.entries()].find(([fullName]) =>
        fullName.toLowerCase() === (renamed.get(match[1]!.toLowerCase()) ?? match[1]!).toLowerCase());
    if (!entry || (entry[1].private && !byId)) return json({ message: 'Not Found' }, 404);
    const [fullName, repo] = entry;
    const rest = byId ? '' : match![2]!;
    try {
      if (rest === '') {
        return json({ id: repo.id, full_name: fullName, default_branch: 'main', pushed_at: repo.pushedAt.toISOString(), private: repo.private });
      }
      const commit = rest.match(/^\/commits\/(.+)$/);
      if (commit) return json(commitJson(repo.dir, git(repo.dir, 'rev-parse', `${decodeURIComponent(commit[1]!)}^{commit}`)));
      if (rest === '/commits') {
        const path = url.searchParams.get('path');
        const shas = git(repo.dir, 'log', '--format=%H', url.searchParams.get('sha')!, ...(path ? ['--', path] : [])).split('\n').filter(Boolean);
        return json(shas.map((sha) => commitJson(repo.dir, sha)));
      }
      const tree = rest.match(/^\/git\/trees\/(.+)$/);
      if (tree) {
        const ref = decodeURIComponent(tree[1]!);
        return json({ sha: git(repo.dir, 'rev-parse', ref.includes(':') ? ref : `${ref}^{tree}`), tree: lsTree(repo.dir, ref), truncated: false });
      }
      const compare = rest.match(/^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/);
      if (compare) {
        const files = git(repo.dir, 'diff', '--numstat', compare[1]!, compare[2]!).split('\n').filter(Boolean).map((line) => {
          const [additions, deletions, filename] = line.split('\t');
          return { filename, status: 'modified', additions: Number(additions), deletions: Number(deletions) };
        });
        return json({ files });
      }
    } catch {
      return json({ message: 'Not Found' }, 404);
    }
    return json({ message: 'Not Found' }, 404);
  };
  globalThis.fetch = fake;

  return {
    /** GitHub API paths requested so far. */
    calls,
    /** Create a repository with a first commit of `files`. */
    repo(fullName: string, files: Files, options: { private?: boolean } = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'agentsync-github-'));
      git(dir, 'init', '-q', '-b', 'main');
      repos.set(fullName, { id: nextId++, dir, private: options.private ?? false, pushedAt: new Date() });
      return this.commit(fullName, files);
    },
    /** Commit changes (`null` deletes a file) on `branch` and return the commit SHA. */
    commit(fullName: string, files: Files, branch = 'main') {
      const repo = repos.get(fullName)!;
      if (branch !== 'main') git(repo.dir, 'checkout', '-q', '-B', branch);
      for (const [path, content] of Object.entries(files)) {
        const file = join(repo.dir, path);
        mkdirSync(dirname(file), { recursive: true });
        rmSync(file, { force: true });
        if (content === null) continue;
        if (typeof content === 'string') writeFileSync(file, content);
        else symlinkSync(content.link, file);
      }
      git(repo.dir, 'add', '-A');
      git(repo.dir, 'commit', '-qm', 'change', '--allow-empty');
      const sha = git(repo.dir, 'rev-parse', 'HEAD');
      if (branch !== 'main') git(repo.dir, 'checkout', '-q', 'main');
      else repo.pushedAt = new Date();
      return sha;
    },
    /** The git tree hash of `path` at `ref`. */
    treeHash(fullName: string, ref: string, path: string) {
      return git(repos.get(fullName)!.dir, 'rev-parse', `${ref}:${path}`);
    },
    /** What `skills` would install from `path` at `ref` (see `installedFolderHash`). */
    installedHash(fullName: string, ref: string, path: string) {
      return installedFolderHash(lsTree(repos.get(fullName)!.dir, ref) as GitTreeItem[], path);
    },
    rename(from: string, to: string) {
      repos.set(to, repos.get(from)!);
      repos.delete(from);
      renamed.set(from.toLowerCase(), to);
    },
    pushedAt: (fullName: string) => repos.get(fullName)!.pushedAt,
    /** Give every scanner the same verdict for a skill. */
    audit(fullName: string, name: string, risk: AuditRisk, analyzedAt = new Date(Date.now() + 1000)) {
      audits.set(fullName, { ...audits.get(fullName), [name]: { risk, analyzedAt } });
    },
    restore() { globalThis.fetch = realFetch; },
  };
}

export const skillMd = (name: string, body = '') => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}`;
