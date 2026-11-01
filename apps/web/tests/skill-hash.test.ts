import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installedFolderHash, UnsupportedSkillFolder, type GitTreeItem } from '../src/skills/hash';

/** A throwaway git repository with `files`, committed. Returns a `git` runner in it. */
function repo(files: Record<string, string | { text: string; exec: true }>) {
  const dir = mkdtempSync(join(tmpdir(), 'agentsync-hash-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'string' ? content : content.text);
    if (typeof content !== 'string') chmodSync(join(dir, path), 0o755);
  }
  git('add', '-A');
  git('commit', '-qm', 'one');
  return { dir, git };
}

/** What GitHub's `git/trees/<sha>?recursive=1` lists, built from `git ls-tree`. */
function listing(git: (...args: string[]) => string): GitTreeItem[] {
  return git('ls-tree', '-r', '-t', 'HEAD').split('\n').map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, type, sha] = meta!.split(' ');
    return { path: path!, mode: mode!, type: type as GitTreeItem['type'], sha: sha! };
  });
}

describe('installedFolderHash', () => {
  it('equals git’s tree hash for the folder when nothing is left out', async () => {
    const { git } = repo({
      'skills/demo/SKILL.md': '---\nname: demo\n---\n',
      'skills/demo/run.sh': { text: '#!/bin/sh\n', exec: true },
      'skills/demo/ref/a b.md': 'a',
      'skills/demo/ref-x.md': 'sorted after ref/ by git',
      'skills/other/SKILL.md': 'other',
    });
    expect(await installedFolderHash(listing(git), 'skills/demo')).toBe(git('rev-parse', 'HEAD:skills/demo'));
  });

  it('equals the tree hash of the folder without what `skills` leaves out on copy', async () => {
    const { git } = repo({
      'SKILL.md': 'root',
      'metadata.json': '{}',
      'nested/metadata.json': '{}',
      'nested/keep.md': 'keep',
      '__pycache__/x.pyc': 'x',
      'only-cache/__pycache__/y.pyc': 'y',
      // `skills` skips a directory named metadata.json too, with everything in it.
      'metadata.json-dir/metadata.json/inside.md': 'gone',
      'metadata.json-dir/kept.md': 'kept',
    });
    const items = listing(git);
    git('rm', '-q', '-r', 'metadata.json', 'nested/metadata.json', '__pycache__', 'only-cache', 'metadata.json-dir/metadata.json');
    git('commit', '-qm', 'without');
    expect(await installedFolderHash(items, '')).toBe(git('rev-parse', 'HEAD^{tree}'));
  });

  it('refuses a folder with a symlink, whose installed bytes it cannot know', async () => {
    const { dir, git } = repo({ 'skills/demo/SKILL.md': 'x' });
    symlinkSync('SKILL.md', join(dir, 'skills/demo/link.md'));
    git('add', '-A');
    git('commit', '-qm', 'link');
    await expect(installedFolderHash(listing(git), 'skills/demo')).rejects.toBeInstanceOf(UnsupportedSkillFolder);
  });

  it('refuses a folder with a submodule', async () => {
    const items: GitTreeItem[] = [
      { path: 'skills/demo/SKILL.md', mode: '100644', type: 'blob', sha: 'a'.repeat(40) },
      { path: 'skills/demo/vendor', mode: '160000', type: 'commit', sha: 'b'.repeat(40) },
    ];
    await expect(installedFolderHash(items, 'skills/demo')).rejects.toBeInstanceOf(UnsupportedSkillFolder);
  });
});
