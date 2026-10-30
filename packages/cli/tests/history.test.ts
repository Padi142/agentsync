import { describe, expect, it } from 'vitest';
import { setup } from './harness.js';

const both = [
  { path: '~/.claude/CLAUDE.md', agent: 'claude' },
  { path: '~/.codex/AGENTS.md', agent: 'codex' },
];

describe('history', () => {
  it('records each sync that wrote a Target: what ran it, and the revision each Target moved from', async () => {
    const t = setup();
    const machine = t.registered(both);
    t.server.putTemplate('one\n');
    await t.cli('sync');
    await t.cli('sync');
    t.server.putTemplate('two\n');
    await t.cli('sync', '--hook', 'claude');
    t.server.state.variables.set(machine.id, { variables: { editor: 'vim' }, revision: 1 });
    t.write('.codex/AGENTS.md', 'two\nhand edit\n');
    await t.cli('sync', '--keep');

    const result = await t.cli('history', '--json');

    expect(result.code).toBe(0);
    // Newest first; the sync that wrote nothing and the Drift that was kept are not there.
    expect(result.json().entries).toMatchObject([
      {
        trigger: 'hook',
        hookAgent: 'claude',
        templateRevision: 2,
        changes: [
          { path: '~/.claude/CLAUDE.md', action: 'updated', previous: { template: 1, variables: 0 }, diff: expect.stringContaining('+two') },
          { path: '~/.codex/AGENTS.md', action: 'updated', previous: { template: 1, variables: 0 } },
        ],
      },
      {
        trigger: 'sync',
        templateRevision: 1,
        changes: [
          { path: '~/.claude/CLAUDE.md', action: 'created', previous: null },
          { path: '~/.codex/AGENTS.md', action: 'created' },
        ],
      },
    ]);
    const text = await t.cli('history', '--agent', 'claude');
    expect(text.stdout).toContain('Claude Code session start');
    expect(text.stdout).toContain('Template revision 2 (was 1)');
    expect(text.stdout).not.toContain('AGENTS.md');
  });

  it('knows the revision a Target moved from even when the history missed a sync, and survives a cut-off line', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    await t.cli('sync');
    t.server.putTemplate('two\n');
    await t.cli('sync');
    // As if revision 2 was never recorded, and a crash cut the log off mid-line.
    t.write('.config/agentsync/history.jsonl', '{"at":"2026-');
    t.server.putTemplate('three\n');
    await t.cli('sync');

    const { entries } = (await t.cli('history', '--json')).json();

    expect(entries).toHaveLength(1);
    expect(entries[0].changes[0]).toMatchObject({ previous: { template: 2 }, diff: expect.stringContaining('-two') });
  });

  it('records a replaced hand edit', async () => {
    const t = setup();
    t.registered(undefined, { '~/.claude/CLAUDE.md': 'one\n' });
    t.write('.claude/CLAUDE.md', 'one\nhand edit\n');
    t.server.putTemplate('two\n');
    await t.cli('sync', '--overwrite');

    const result = await t.cli('history', '--verbose');

    expect(result.stdout).toContain('Template revision 1 replaced a hand edit, kept in CLAUDE.md.agentsync-backup');
    expect(result.stdout).toContain('-hand edit');
  });
});
