import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './harness.js';

describe('template', () => {
  it('prints the Template, or writes it with --out', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('Hello {{name}}\n');

    expect((await t.cli('template')).stdout).toBe('Hello {{name}}\n');
    expect((await t.cli('template', '--json')).json()).toMatchObject({ revision: 1, text: 'Hello {{name}}\n' });
    await t.cli('template', '--out', '~/t.md');
    expect(readFileSync(t.path('t.md'), 'utf8')).toBe('Hello {{name}}\n');
  });
});

describe('vars', () => {
  it('sets and unsets this Machine’s Variables, and lists them', async () => {
    const t = setup();
    const machine = t.registered();
    t.server.state.variables.set(machine.id, { variables: { editor: 'vim', shell: 'bash' }, revision: 1 });

    const changed = await t.cli('vars', '--var', 'shell=fish', '--unset', 'editor');

    expect(changed.code).toBe(0);
    expect(t.server.state.variables.get(machine.id)).toEqual({ variables: { shell: 'fish' }, revision: 2 });
    expect((await t.cli('vars', '--json')).json()).toMatchObject({ variables: { shell: 'fish' }, revision: 2 });
    expect((await t.cli('vars')).stdout).toBe('shell=fish\n');
  });
});

describe('status', () => {
  it('shows each Target’s state and open Conflicts without writing anything', async () => {
    const t = setup();
    t.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/.codex/AGENTS.md', agent: 'codex' },
    ], { '~/.claude/CLAUDE.md': 'one\n' });
    t.write('.claude/CLAUDE.md', 'hand edit\n');
    t.server.putTemplate('one\n');

    const result = await t.cli('status', '--json');

    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({
      machine: { name: 'laptop' },
      templateRevision: 1,
      openConflicts: { count: 0 },
      targets: [
        { path: '~/.claude/CLAUDE.md', status: 'drift' },
        { path: '~/.codex/AGENTS.md', status: 'missing' },
      ],
    });
    expect(existsSync(t.path('.codex/AGENTS.md'))).toBe(false);
  });
});

describe('logout', () => {
  it('revokes the Machine and removes its token, hooks and skill, leaving other hooks', async () => {
    const t = setup();
    t.write('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bell' }] }] } }));
    await t.cli('init', '--yes', '--server', t.server.url);
    expect(t.server.state.machines.size).toBe(1);

    const result = await t.cli('logout');

    expect(result.code).toBe(0);
    expect(t.server.state.machines.size).toBe(0);
    expect(existsSync(t.path('.config/agentsync/config.json'))).toBe(false);
    expect(JSON.parse(readFileSync(t.path('.claude/settings.json'), 'utf8'))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bell' }] }] },
    });
    expect(existsSync(t.path('.claude/skills/agentsync'))).toBe(false);
  });

  it('leaves a hook of the person’s own that mentions the AgentSync command', async () => {
    const t = setup();
    const wrapper = { type: 'command', command: 'audit-wrapper agentsync sync --hook claude; run-other-setup' };
    t.write('.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [wrapper] }] } }));
    await t.cli('init', '--yes', '--server', t.server.url);

    await t.cli('logout');

    expect(JSON.parse(readFileSync(t.path('.claude/settings.json'), 'utf8'))).toEqual({
      hooks: { SessionStart: [{ hooks: [wrapper] }] },
    });
  });

  it('keeps a skill file the person changed since AgentSync wrote it', async () => {
    const t = setup();
    mkdirSync(t.path('.claude'));
    await t.cli('init', '--yes', '--server', t.server.url);
    const skill = t.path('.claude/skills/agentsync/SKILL.md');
    writeFileSync(skill, `${readFileSync(skill, 'utf8')}\nMy addition.\n`);

    const result = await t.cli('logout');

    expect(result.code).toBe(0);
    expect(readFileSync(skill, 'utf8')).toContain('My addition.');
    expect(result.stderr).toContain('~/.claude/skills/agentsync/SKILL.md');
  });

  it('still cleans up when the server already revoked the Machine', async () => {
    const t = setup();
    t.registered();
    t.server.state.tokens.clear();

    const result = await t.cli('logout');

    expect(result.code).toBe(0);
    expect(existsSync(t.path('.config/agentsync/config.json'))).toBe(false);
  });
});

describe('usage', () => {
  it('exits 2 for an unknown command or flag', async () => {
    const t = setup();

    expect((await t.cli('frobnicate')).code).toBe(2);
    expect((await t.cli('sync', '--frobnicate')).code).toBe(2);
    expect((await t.cli('sync', '--overwrite', '--keep')).code).toBe(2);
    expect((await t.cli()).code).toBe(2);
    expect((await t.cli('--help')).code).toBe(0);
  });
});
