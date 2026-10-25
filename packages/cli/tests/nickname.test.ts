import { mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './harness.js';

const only = (t: ReturnType<typeof setup>) => [...t.server.state.machines.values()][0]!;

describe('Machine nicknames', () => {
  it('asks for a nickname at a terminal, with the hostname as the default', async () => {
    const t = setup();
    mkdirSync(t.path('.claude'));
    t.answer('Work laptop', 'claude');

    const result = await t.cli('init', '--server', t.server.url);

    expect(result.code).toBe(0);
    expect(only(t).nickname).toBe('Work laptop');
    expect(t.questions[0]).toBe('Machine nickname');
  });

  it('keeps the nickname from init --no-wait for the init that finishes registering', async () => {
    const t = setup();
    mkdirSync(t.path('.codex'));

    await t.cli('init', '--yes', '--no-wait', '--nickname', '  Home server ', '--server', t.server.url);
    const finished = await t.cli('init', '--yes');

    expect(finished.code).toBe(0);
    expect(only(t).nickname).toBe('Home server');
  });

  it('refuses an empty or overlong --name before registering', async () => {
    const t = setup();
    mkdirSync(t.path('.codex'));

    expect((await t.cli('init', '--yes', '--nickname', ' ', '--server', t.server.url)).code).toBe(2);
    expect((await t.cli('init', '--yes', '--nickname', 'x'.repeat(101), '--server', t.server.url)).code).toBe(2);
    expect(t.server.state.machines.size).toBe(0);
  });

  it('renames this Machine without touching its Targets', async () => {
    const t = setup();
    const machine = t.registered();

    const result = await t.cli('rename', 'Home server', '--json');

    expect(result.code).toBe(0);
    expect(result.json()).toEqual({ ok: true, machine: { id: machine.id, nickname: 'Home server', hostname: 'laptop' } });
    expect(only(t)).toMatchObject({ id: machine.id, nickname: 'Home server', hostname: 'laptop', targets: machine.targets });
    expect((await t.cli('rename')).code).toBe(2);
    expect((await t.cli('rename', '')).code).toBe(2);
  });

  it('renames a registered Machine with init --name, and an ordinary init keeps the nickname', async () => {
    const t = setup();
    t.registered();
    mkdirSync(t.path('.claude'));

    await t.cli('init', '--yes', '--nickname', 'Desk', '--server', t.server.url);
    expect(only(t).nickname).toBe('Desk');

    await t.cli('init', '--yes', '--server', t.server.url);
    expect(only(t).nickname).toBe('Desk');
  });

  it('renders {{machine.nickname}} and {{machine.hostname}} as separate values', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('{{machine.nickname}} / {{machine.hostname}}\n');
    await t.cli('rename', 'Desk');

    expect((await t.cli('sync')).code).toBe(0);
    expect((await import('node:fs')).readFileSync(t.path('.claude/CLAUDE.md'), 'utf8')).toBe('Desk / laptop\n');
  });

  it('reports a changed hostname on init, without touching the nickname', async () => {
    const t = setup();
    t.registered();
    only(t).hostname = 'old-host';
    mkdirSync(t.path('.claude'));

    await t.cli('init', '--yes', '--server', t.server.url);

    expect(only(t)).toMatchObject({ nickname: 'laptop', hostname: 'laptop' });
  });
});
