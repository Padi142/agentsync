import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTarget, writeTarget } from '../src/targets.js';

const file = (text?: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'agentsync-target-')), 'AGENTS.md');
  if (text !== undefined) writeFileSync(path, text);
  return path;
};

describe('checkTarget', () => {
  it('is missing when nothing is on disk, even if AgentSync wrote it before', () => {
    expect(checkTarget({ path: file(), rendered: 'new\n', lastWritten: 'old\n' }).status).toBe('missing');
  });

  it('is current when the file already holds the Rendered output', () => {
    expect(checkTarget({ path: file('same\n'), rendered: 'same\n', lastWritten: 'old\n' }).status).toBe('current');
    expect(checkTarget({ path: file('same\n'), rendered: 'same\n' }).status).toBe('current');
  });

  it('is stale when the file is what AgentSync last wrote and the Template moved on', () => {
    expect(checkTarget({ path: file('old\n'), rendered: 'new\n', lastWritten: 'old\n' }).status).toBe('stale');
  });

  it('is Drift when the file was edited by hand since AgentSync wrote it, with the hand edit as a diff', () => {
    const result = checkTarget({
      path: file('# Rules\nuse pnpm\nhand edit\n'),
      rendered: '# Rules\nuse pnpm\nfrom another Machine\n',
      lastWritten: '# Rules\nuse pnpm\n',
    });

    expect(result.status).toBe('drift');
    expect(result.diff).toContain('+hand edit');
    // The diff is against what AgentSync wrote, so a Template change made elsewhere is not shown as removed.
    expect(result.diff).not.toContain('from another Machine');
  });

  it('is Drift when a file AgentSync never wrote differs from the Rendered output', () => {
    const result = checkTarget({ path: file('my own notes\n'), rendered: 'the Template\n' });

    expect(result.status).toBe('drift');
    expect(result.diff).toContain('-the Template');
    expect(result.diff).toContain('+my own notes');
  });
});

describe('writeTarget', () => {
  it('backs up the file it replaces when asked', () => {
    const path = file('hand edit\n');

    writeTarget(path, 'rendered\n', { backup: true });

    expect(readFileSync(path, 'utf8')).toBe('rendered\n');
    expect(readFileSync(`${path}.agentsync-backup`, 'utf8')).toBe('hand edit\n');
  });

  it('creates missing directories', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentsync-target-')), 'new', 'CLAUDE.md');

    writeTarget(path, 'rendered\n', { backup: true });

    expect(readFileSync(path, 'utf8')).toBe('rendered\n');
  });
});
