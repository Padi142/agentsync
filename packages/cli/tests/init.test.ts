import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './harness.js';

describe('init', () => {
  it('registers the Machine with the device flow and keeps its token private', async () => {
    const t = setup();
    mkdirSync(t.path('.claude'));

    const result = await t.cli('init', '--yes', '--server', t.server.url);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ABCD-EFGH');
    expect(result.stdout).toContain(`${t.server.url}/device?code=ABCD-EFGH`);
    const [machine] = t.server.state.machines.values();
    expect(machine).toMatchObject({
      name: 'laptop',
      os: 'linux',
      targets: [{ path: '~/.claude/CLAUDE.md', agent: 'claude' }],
    });
    const configFile = t.path('.config/agentsync/config.json');
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toMatchObject({
      server: t.server.url,
      machineId: machine!.id,
    });
  });

  it.each(['denied', 'expired', 'invalid'] as const)('exits with the auth code when registration is %s', async (status) => {
    const t = setup();
    mkdirSync(t.path('.claude'));
    t.server.state.nextDevice = status === 'invalid' ? 'used' : status;

    const result = await t.cli('init', '--yes', '--json', '--server', t.server.url);

    expect(result.code).toBe(5);
    expect(result.json()).toMatchObject({ ok: false, error: { status } });
    expect(t.server.state.machines.size).toBe(0);
  });

  it('with --no-wait prints the code and exits, and the next init finishes registering', async () => {
    const t = setup();
    mkdirSync(t.path('.codex'));

    const started = await t.cli('init', '--yes', '--json', '--no-wait', '--server', t.server.url);

    expect(started.code).toBe(0);
    expect(started.json()).toMatchObject({
      status: 'pending',
      userCode: 'ABCD-EFGH',
      verificationUri: `${t.server.url}/device?code=ABCD-EFGH`,
    });
    expect(t.server.state.machines.size).toBe(0);

    const finished = await t.cli('init', '--yes', '--json');

    expect(finished.code).toBe(0);
    expect([...t.server.state.machines.values()]).toMatchObject([
      { targets: [{ path: '~/.codex/AGENTS.md', agent: 'codex' }] },
    ]);
  });

  it('waits the interval each pending poll asks for', async () => {
    const t = setup();
    mkdirSync(t.path('.claude'));
    t.server.state.nextDevice = 'pending';

    const result = await t.cli('init', '--yes', '--server', t.server.url);

    expect(result.code).toBe(0);
    expect(t.sleeps).toEqual([1000, 7000]);
  });

  it('refuses to run without a server', async () => {
    const t = setup();
    mkdirSync(t.path('.claude'));

    const result = await t.cli('init', '--yes');

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--server');
  });

  describe('on the first Machine of an account', () => {
    it('imports the largest existing Target as Template revision 1, and treats the others as Drift', async () => {
      const t = setup();
      t.write('.codex/AGENTS.md', '# My rules\n\nAlways use pnpm.\n');
      t.write('.claude/CLAUDE.md', '@~/.agents/AGENTS.md\n');

      const result = await t.cli('init', '--yes', '--json', '--server', t.server.url);

      expect(t.server.state.template).toMatchObject({ revision: 1, text: '# My rules\n\nAlways use pnpm.\n' });
      expect(result.code).toBe(3);
      expect(result.json()).toMatchObject({
        imported: '~/.codex/AGENTS.md',
        targets: [
          { path: '~/.claude/CLAUDE.md', status: 'drift' },
          { path: '~/.codex/AGENTS.md', status: 'unchanged' },
        ],
      });
      expect(readFileSync(t.path('.claude/CLAUDE.md'), 'utf8')).toBe('@~/.agents/AGENTS.md\n');
    });

    it('imports the file given with --import, keeping a literal {{ literal', async () => {
      const t = setup();
      mkdirSync(t.path('.claude'));
      t.write('notes/AGENTS.md', 'Use {{name}} in Handlebars.\n');

      const result = await t.cli('init', '--yes', '--server', t.server.url, '--import', '~/notes/AGENTS.md');

      expect(result.code).toBe(0);
      expect(t.server.state.template.text).toBe('Use \\{{name}} in Handlebars.\n');
      expect(readFileSync(t.path('.claude/CLAUDE.md'), 'utf8')).toBe('Use {{name}} in Handlebars.\n');
    });
  });

  it('on a later Machine treats a different existing file as Drift, which --overwrite backs up', async () => {
    const t = setup();
    t.server.putTemplate('The Template\n');
    t.write('.claude/CLAUDE.md', 'old notes\n');

    const result = await t.cli('init', '--yes', '--overwrite', '--server', t.server.url);

    expect(result.code).toBe(0);
    expect(t.server.state.template.revision).toBe(1);
    expect(readFileSync(t.path('.claude/CLAUDE.md'), 'utf8')).toBe('The Template\n');
    expect(readFileSync(t.path('.claude/CLAUDE.md.agentsync-backup'), 'utf8')).toBe('old notes\n');
  });

  it('saves Variables given with --var', async () => {
    const t = setup();
    mkdirSync(t.path('.claude'));
    t.server.putTemplate('editor: {{editor}}\n');

    const result = await t.cli('init', '--yes', '--server', t.server.url, '--var', 'editor=vim', '--var', 'shell=fish');

    expect(result.code).toBe(0);
    const [variables] = t.server.state.variables.values();
    expect(variables).toEqual({ variables: { editor: 'vim', shell: 'fish' }, revision: 1 });
    expect(readFileSync(t.path('.claude/CLAUDE.md'), 'utf8')).toBe('editor: vim\n');
  });

  it('asks for the Variables the Template uses at a terminal', async () => {
    const t = setup();
    mkdirSync(t.path('.claude'));
    t.server.putTemplate('editor: {{editor}}{{if os == "x"}}{{shell}}{{end}}\n');
    t.answer('vim', '', '');

    const result = await t.cli('init', '--server', t.server.url);

    expect(result.code).toBe(0);
    const [variables] = t.server.state.variables.values();
    expect(variables?.variables).toEqual({ editor: 'vim' });
  });

  it('installs the SessionStart hooks and the agent skill for each agent', async () => {
    const t = setup();
    mkdirSync(t.path('.claude'));
    mkdirSync(t.path('.codex'));
    t.write('.claude/settings.json', JSON.stringify({ model: 'opus' }));

    const result = await t.cli('init', '--yes', '--server', t.server.url);

    expect(result.code).toBe(0);
    const claude = JSON.parse(readFileSync(t.path('.claude/settings.json'), 'utf8'));
    expect(claude).toMatchObject({ model: 'opus', hooks: { SessionStart: [{ hooks: [{ command: 'agentsync sync --hook claude' }] }] } });
    const codex = JSON.parse(readFileSync(t.path('.codex/hooks.json'), 'utf8'));
    expect(codex).toMatchObject({ hooks: { SessionStart: [{ hooks: [{ command: 'agentsync sync --hook codex' }] }] } });
    expect(result.stdout).toContain('/hooks');
    expect(readFileSync(t.path('.claude/skills/agentsync/SKILL.md'), 'utf8')).toContain('name: agentsync');
    expect(existsSync(t.path('.agents/skills/agentsync/SKILL.md'))).toBe(true);
  });

  it('with --no-hooks and --no-skill installs neither', async () => {
    const t = setup();
    mkdirSync(t.path('.claude'));

    await t.cli('init', '--yes', '--no-hooks', '--no-skill', '--server', t.server.url);

    expect(existsSync(t.path('.claude/settings.json'))).toBe(false);
    expect(existsSync(t.path('.claude/skills'))).toBe(false);
  });

  it('run again on a registered Machine updates its Targets instead of registering again', async () => {
    const t = setup();
    mkdirSync(t.path('.claude'));
    await t.cli('init', '--yes', '--server', t.server.url);
    mkdirSync(t.path('.codex'));

    const result = await t.cli('init', '--yes');

    expect(result.code).toBe(0);
    expect(t.server.state.machines.size).toBe(1);
    const [machine] = t.server.state.machines.values();
    expect(machine!.targets.map((target) => target.agent)).toEqual(['claude', 'codex']);
  });
});
