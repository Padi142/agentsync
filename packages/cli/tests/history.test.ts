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
          { path: '~/.claude/CLAUDE.md', action: 'updated', previousTemplateRevision: 1, diff: expect.stringContaining('+two') },
          { path: '~/.codex/AGENTS.md', action: 'updated', previousTemplateRevision: 1 },
        ],
      },
      {
        trigger: 'sync',
        templateRevision: 1,
        changes: [
          { path: '~/.claude/CLAUDE.md', action: 'created', previousTemplateRevision: null },
          { path: '~/.codex/AGENTS.md', action: 'created' },
        ],
      },
    ]);
    const text = await t.cli('history', '--agent', 'claude');
    expect(text.stdout).toContain('Claude Code session start');
    expect(text.stdout).toContain('Template revision 2 (was 1)');
    expect(text.stdout).not.toContain('AGENTS.md');
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
