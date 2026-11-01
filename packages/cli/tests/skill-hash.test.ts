import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { folderHash } from '../src/skills/hash.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();

function folder(files: Record<string, string>, exec: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'agentsync-folder-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  for (const path of exec) chmodSync(join(dir, path), 0o755);
  return dir;
}

describe('folderHash', () => {
  it('equals git’s tree hash of the folder, exec bits and git’s sort order included', async () => {
    const dir = folder({ 'SKILL.md': 'x', 'run.sh': '#!/bin/sh\n', 'ref/a.md': 'a', 'ref-b.md': 'b', 'ü.md': 'u' }, ['run.sh']);
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    expect(await folderHash(dir)).toBe(git(dir, 'write-tree'));
  });

  it('leaves out what `skills` never copies, and what running a skill’s scripts writes', async () => {
    const dir = folder({ 'SKILL.md': 'x', 'sub/keep.md': 'k' });
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    const clean = git(dir, 'write-tree');
    writeFileSync(join(dir, 'metadata.json'), '{}');
    mkdirSync(join(dir, 'sub', '__pycache__'));
    writeFileSync(join(dir, 'sub', '__pycache__', 'x.pyc'), 'compiled');
    expect(await folderHash(dir)).toBe(clean);
  });

  it('changes when a file is edited', async () => {
    const dir = folder({ 'SKILL.md': 'x' });
    const before = await folderHash(dir);
    writeFileSync(join(dir, 'SKILL.md'), 'y');
    expect(await folderHash(dir)).not.toBe(before);
  });
});
