import { chmodSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './harness.js';

const read = (path: string) => readFileSync(path, 'utf8');
/** Claude Code and Codex get JSON: `systemMessage` for the person, `additionalContext` for the model. */
const hookJson = (stdout: string) => {
  const output = JSON.parse(stdout);
  expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
  return { person: output.systemMessage as string | undefined, model: output.hookSpecificOutput.additionalContext as string };
};

describe('sync --hook', () => {
  it('says nothing when everything is up to date', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    await t.cli('sync');

    const result = await t.cli('sync', '--hook', 'claude');

    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('tells the model to read the updated Target, and the person what changed', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');

    // --json must not add a second document: the hook's JSON is all of stdout.
    const result = await t.cli('sync', '--hook', 'claude', '--json');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('one\n');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    const { person, model } = hookJson(result.stdout);
    expect(model).toContain('read ~/.claude/CLAUDE.md');
    expect(person).toBe(
      'AgentSync: updated ~/.claude/CLAUDE.md to Template revision 1; run `agentsync history` to see what changed.',
    );
  });

  it('for pi, which reads its instructions after the hook, only says what it updated', async () => {
    const t = setup();
    t.registered([{ path: '~/.pi/agent/AGENTS.md', agent: 'pi' }]);
    t.server.putTemplate('one\n');

    const result = await t.cli('sync', '--hook', 'pi');

    expect(result.code).toBe(0);
    expect(read(t.path('.pi/agent/AGENTS.md'))).toBe('one\n');
    expect(result.stdout).toBe('AgentSync: updated ~/.pi/agent/AGENTS.md to Template revision 1.\n');
  });

  it('keeps the existing files and exits 0 when the server cannot be reached', async () => {
    const t = setup();
    t.registered(undefined, { '~/.claude/CLAUDE.md': 'one\n' });
    t.write('.claude/CLAUDE.md', 'one\n');
    t.server.state.offline = true;

    const result = await t.cli('sync', '--hook', 'claude');

    expect(result.code).toBe(0);
    expect(read(t.path('.claude/CLAUDE.md'))).toBe('one\n');
    // Nothing changed, so only the model hears about it.
    const { person, model } = hookJson(result.stdout);
    expect(model).toMatch(/^AgentSync: kept the existing instructions: Could not reach/);
    expect(person).toBeUndefined();
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
    expect(hookJson(result.stdout).person).toContain('~/.claude/CLAUDE.md has Drift');
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
    expect(hookJson(result.stdout)).toEqual({
      person: `AgentSync: 1 open Conflict(s), resolve at ${t.server.url}/conflicts.`,
      model: `AgentSync: 1 open Conflict(s), resolve at ${t.server.url}/conflicts.`,
    });
  });

  it('exits 0 even when this Machine is not registered or its config is broken', async () => {
    const t = setup();
    expect((await t.cli('sync', '--hook', 'claude')).code).toBe(0);

    t.write('.config/agentsync/config.json', '{ not json');

    const result = await t.cli('sync', '--hook', 'claude');
    expect(result.code).toBe(0);
    expect(hookJson(result.stdout).model).toMatch(/^AgentSync: /);
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
      const { person, model } = hookJson(result.stdout);
      expect(model).toMatch(/^AgentSync: sync failed; some Targets may have been updated: /);
      expect(model).not.toContain('kept the existing instructions');
      expect(person).toMatch(/^AgentSync: sync failed; some Targets may have been updated: /);
    } finally {
      chmodSync(t.path('.config/agentsync'), 0o700);
    }
  });
});
