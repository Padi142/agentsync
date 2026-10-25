import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeText } from '../src/files.js';

const dir = () => mkdtempSync(join(tmpdir(), 'agentsync-files-'));
const mode = (path: string) => statSync(path).mode & 0o777;

describe('writeText', () => {
  it('keeps the mode of the file it replaces', () => {
    const path = join(dir(), 'settings.json');
    writeFileSync(path, '{}');
    chmodSync(path, 0o600);

    writeText(path, '{"hooks":{}}');

    expect(readFileSync(path, 'utf8')).toBe('{"hooks":{}}');
    expect(mode(path)).toBe(0o600);
  });

  it('gives a new file the restrictive mode it is asked for', () => {
    const path = join(dir(), 'hooks.json');

    writeText(path, '{}', { createMode: 0o600 });

    expect(mode(path)).toBe(0o600);
  });

  it('can force a mode on an existing file', () => {
    const path = join(dir(), 'config.json');
    writeFileSync(path, '{}');
    chmodSync(path, 0o644);

    writeText(path, '{"token":"x"}', { mode: 0o600 });

    expect(mode(path)).toBe(0o600);
  });

  it('leaves no temporary file behind', () => {
    const parent = dir();

    writeText(join(parent, 'a.md'), 'one');
    writeText(join(parent, 'a.md'), 'two');

    expect(readdirSync(parent)).toEqual(['a.md']);
  });

  it('writes through a symlink to the file it points to, keeping the link', () => {
    const parent = dir();
    const source = join(parent, 'dotfiles-CLAUDE.md');
    const link = join(parent, 'CLAUDE.md');
    writeFileSync(source, 'old');
    chmodSync(source, 0o640);
    symlinkSync(source, link);

    writeText(link, 'new');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(source);
    expect(readFileSync(source, 'utf8')).toBe('new');
    expect(mode(source)).toBe(0o640);
  });

  it('writes through a dangling symlink, creating the file it points to', () => {
    const parent = dir();
    const link = join(parent, 'CLAUDE.md');
    symlinkSync('dotfiles/CLAUDE.md', link);

    writeText(link, 'new');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(parent, 'dotfiles', 'CLAUDE.md'), 'utf8')).toBe('new');
  });
});
