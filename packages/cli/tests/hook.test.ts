import { chmodSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './harness.js';

const read = (path: string) => readFileSync(path, 'utf8');

describe('sync --hook', () => {
  it('says nothing when everything is up to date', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    await t.cli('sync');

    const result = await t.cli('sync', '--hook', 'claude');

    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('prints one line when it updates the running agent’s Target, pointing at the new file', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');

    const result = await t.cli('sync', '--hook', 'claude');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('one\n');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout).toContain('read ~/.claude/CLAUDE.md');
  });

  it('keeps the existing files and exits 0 when the server cannot be reached', async () => {
    const t = setup();
    t.registered(undefined, { '~/.claude/CLAUDE.md': 'one\n' });
    t.write('.claude/CLAUDE.md', 'one\n');
    t.server.state.offline = true;

    const result = await t.cli('sync', '--hook', 'claude');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('one\n');
    expect(result.stdout).toMatch(/^AgentSync: kept the existing instructions: Could not reach/);
  });

  it('skips a Target with Drift without prompting, even at a terminal', async () => {
    const t = setup();
    t.registered(undefined, { '~/.claude/CLAUDE.md': 'one\n' });
    t.write('.claude/CLAUDE.md', 'hand edit\n');
    t.server.putTemplate('two\n');
    t.answer();

    const result = await t.cli('sync', '--hook', 'claude');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('hand edit\n');
    expect(result.stdout).toContain('~/.claude/CLAUDE.md has Drift');
  });

  it('mentions open Conflicts with a link', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    await t.cli('sync');
    t.server.state.conflicts.push({
      id: 'c1', baseRevision: 0, serverRevision: 1, text: '', status: 'open',
      url: `${t.server.url}/conflicts/c1`, createdAt: new Date(), closedAt: null,
    });

    const result = await t.cli('sync', '--hook', 'codex');

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`AgentSync: 1 open Conflict(s), resolve at ${t.server.url}/conflicts.\n`);
  });

  it('exits 0 even when this Machine is not registered or its config is broken', async () => {
    const t = setup();
    expect((await t.cli('sync', '--hook', 'claude')).code).toBe(0);

    t.write('.config/agentsync/config.json', '{ not json');

    const result = await t.cli('sync', '--hook', 'claude');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^AgentSync: /);
  });

  it('does not claim it kept the instructions when it failed after writing a Target', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    chmodSync(t.path('.config/agentsync'), 0o500);
    try {
      const result = await t.cli('sync', '--hook', 'claude');

      expect(result.code).toBe(0);
      expect(read(t.path('.claude/CLAUDE.md'))).toBe('one\n');
      expect(result.stdout).toMatch(/^AgentSync: sync failed; some Targets may have been updated: /);
      expect(result.stdout).not.toContain('kept the existing instructions');
    } finally {
      chmodSync(t.path('.config/agentsync'), 0o700);
    }
  });
});
