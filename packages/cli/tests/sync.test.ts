import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './harness.js';

const read = (path: string) => readFileSync(path, 'utf8');
const both = [
  { path: '~/.claude/CLAUDE.md', agent: 'claude' },
  { path: '~/.codex/AGENTS.md', agent: 'codex' },
];

describe('sync', () => {
  it('Renders the Template into each Target with its Variables and Built-in Variables', async () => {
    const t = setup();
    const machine = t.registered(both);
    t.server.putTemplate('{{agent}} on {{machine.hostname}} ({{machine.os}}) uses {{editor}}\n');
    t.server.state.variables.set(machine.id, { variables: { editor: 'vim' }, revision: 1 });

    const result = await t.cli('sync');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('claude on laptop (linux) uses vim\n');
    expect(read(t.path('.codex/AGENTS.md'))).toBe('codex on laptop (linux) uses vim\n');
  });

  it('warns about a missing Variable and still writes', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('editor: {{editor}}\n');

    const result = await t.cli('sync');

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('editor');
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('editor: \n');
  });

  it('updates a Target AgentSync wrote when the Template changes', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    await t.cli('sync');
    t.server.putTemplate('two\n');

    const result = await t.cli('sync');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('two\n');
  });

  it('stops on Drift with exit code 3 and leaves the hand edit alone', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    await t.cli('sync');
    t.write('.claude/CLAUDE.md', 'one\nhand edit\n');
    t.server.putTemplate('two\n');

    const result = await t.cli('sync', '--json');

    expect(result.code).toBe(3);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('one\nhand edit\n');
    expect(result.json()).toMatchObject({
      ok: false,
      targets: [{ path: '~/.claude/CLAUDE.md', status: 'drift', diff: expect.stringContaining('+hand edit') }],
    });
  });

  it('with --overwrite discards the hand edit, keeping a backup', async () => {
    const t = setup();
    t.registered(undefined, { '~/.claude/CLAUDE.md': 'one\n' });
    t.write('.claude/CLAUDE.md', 'one\nhand edit\n');
    t.server.putTemplate('two\n');

    const result = await t.cli('sync', '--overwrite');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('two\n');
    expect(read(t.path('.claude/CLAUDE.md.agentsync-backup'))).toBe('one\nhand edit\n');
  });

  it('with --keep skips the Target and succeeds', async () => {
    const t = setup();
    t.registered(undefined, { '~/.claude/CLAUDE.md': 'one\n' });
    t.write('.claude/CLAUDE.md', 'one\nhand edit\n');
    t.server.putTemplate('two\n');

    const result = await t.cli('sync', '--keep');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('one\nhand edit\n');
  });

  it('asks what to do about Drift at a terminal', async () => {
    const t = setup();
    t.registered(both, { '~/.claude/CLAUDE.md': 'one\n', '~/.codex/AGENTS.md': 'one\n' });
    t.write('.claude/CLAUDE.md', 'claude edit\n');
    t.write('.codex/AGENTS.md', 'codex edit\n');
    t.server.putTemplate('two\n');
    t.answer('overwrite', 'keep');

    const result = await t.cli('sync');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('two\n');
    expect(read(t.path('.codex/AGENTS.md'))).toBe('codex edit\n');
  });

  it('can hand Drift to an agent, which is remembered for this Machine', async () => {
    const t = setup();
    t.registered(undefined, { '~/.claude/CLAUDE.md': 'one\n' });
    t.write('.claude/CLAUDE.md', 'one\nhand edit\n');
    t.server.putTemplate('one\n');
    t.answer('agent', 'claude');

    const result = await t.cli('sync');

    expect(result.code).toBe(0);
    expect(t.launched).toMatchObject([{ agent: 'claude', prompt: expect.stringContaining('+hand edit') }]);
    const config = JSON.parse(read(t.path('.config/agentsync/config.json')));
    expect(config.handoffAgent).toBe('claude');
  });

  it('writes nothing while the account has no Template yet', async () => {
    const t = setup();
    t.registered();
    t.write('.claude/CLAUDE.md', 'my notes\n');

    const result = await t.cli('sync');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('my notes\n');
  });

  it('exits with the auth code when the Machine was revoked', async () => {
    const t = setup();
    t.registered();
    t.server.state.tokens.clear();

    const result = await t.cli('sync');

    expect(result.code).toBe(5);
    expect(result.stderr).toContain('agentsync init');
  });

  it('exits with the auth code before this Machine is registered', async () => {
    const t = setup();

    expect((await t.cli('sync')).code).toBe(5);
  });

  it('sends the Machine token, and neither an Origin header nor cookies', async () => {
    const t = setup();
    t.registered();

    await t.cli('sync');

    const [headers] = t.server.state.requests;
    expect(headers!.get('Authorization')).toMatch(/^Bearer token-/);
    expect(headers!.get('Origin')).toBeNull();
    expect(headers!.get('Cookie')).toBeNull();
  });

  it('updates the file a symlinked Target points to, keeping the link', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    t.write('dotfiles/CLAUDE.md', '');
    mkdirSync(t.path('.claude'));
    symlinkSync(t.path('dotfiles/CLAUDE.md'), t.path('.claude/CLAUDE.md'));

    expect((await t.cli('sync', '--overwrite')).code).toBe(0);
    t.server.putTemplate('two\n');
    expect((await t.cli('sync')).code).toBe(0);

    expect(lstatSync(t.path('.claude/CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(read(t.path('dotfiles/CLAUDE.md'))).toBe('two\n');
  });

  it('skips a relative Target path stored on the server, with a warning', async () => {
    const t = setup();
    t.registered([{ path: 'AGENTS.md', agent: 'codex' }, { path: '~/.claude/CLAUDE.md', agent: 'claude' }]);
    t.server.putTemplate('one\n');

    const result = await t.cli('sync', '--json');

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('AGENTS.md');
    expect(result.json().targets).toMatchObject([{ path: '~/.claude/CLAUDE.md', status: 'written' }]);
  });

  describe('when one Target cannot be written', () => {
    /** Two Targets, the second blocked by a file where its directory should be. */
    const blocked = () => {
      const t = setup();
      t.registered([
        { path: '~/.claude/CLAUDE.md', agent: 'claude' },
        { path: '~/blocked/AGENTS.md', agent: 'codex' },
      ]);
      t.write('blocked', 'a file, not a directory');
      t.server.putTemplate('v1\n');
      return t;
    };

    it('still writes and remembers the others, so the next sync sees no false Drift', async () => {
      const t = blocked();

      const failed = await t.cli('sync', '--json');

      expect(failed.code).toBe(1);
      expect(failed.json().targets).toMatchObject([
        { path: '~/.claude/CLAUDE.md', status: 'written' },
        { path: '~/blocked/AGENTS.md', status: 'error' },
      ]);
      expect(read(t.path('.claude/CLAUDE.md'))).toBe('v1\n');

      rmSync(t.path('blocked'));
      t.server.putTemplate('v2\n');
      const next = await t.cli('sync');

      expect(next.code).toBe(0);
      expect(read(t.path('.claude/CLAUDE.md'))).toBe('v2\n');
      expect(read(t.path('blocked/AGENTS.md'))).toBe('v2\n');
    });

    it('in a hook, reports both the update and the failure', async () => {
      const t = blocked();

      const result = await t.cli('sync', '--hook', 'claude');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('updated ~/.claude/CLAUDE.md');
      expect(result.stdout).toContain('could not write ~/blocked/AGENTS.md');
      expect(result.stdout).not.toContain('kept the existing instructions');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
    });
  });
});
