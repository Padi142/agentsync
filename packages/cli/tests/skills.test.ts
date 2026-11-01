import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './harness.js';

const sha = (c: string) => c.repeat(40);
const both = [{ path: '~/.claude/CLAUDE.md', agent: 'claude' }, { path: '~/.codex/AGENTS.md', agent: 'codex' }];

/** A registered Machine with Claude Code and Codex, and `animate` and `polish` (one repo, one commit) set for it. */
async function machineWithSkills() {
  const t = setup();
  t.registered(both);
  const animate = await t.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
  const polish = await t.skills.publish('emil/skills', sha('1'), 'polish', { 'SKILL.md': 'polish v1' });
  t.server.state.skills = [
    { name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: animate },
    { name: 'polish', repo: 'emil/skills', commit: sha('1'), installedHash: polish },
  ];
  return t;
}

const statuses = (result: { json: () => { skills: { name: string; status: string }[] } }) =>
  Object.fromEntries(result.json().skills.map((skill) => [skill.name, skill.status]));

describe('skills sync', () => {
  it('installs the Skills from one repository and commit with one `skills add`, for every agent with a Target', async () => {
    const t = await machineWithSkills();

    const result = await t.cli('skills', 'sync', '--json');

    expect(result.code).toBe(0);
    expect(t.skills.calls).toEqual([
      ['add', `emil/skills#${sha('1')}`, '--skill', 'animate', 'polish', '-g', '-a', 'claude-code', 'codex', '-y', '--json'],
    ]);
    expect(statuses(result)).toEqual({ animate: 'installed', polish: 'installed' });
    expect(readFileSync(t.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
    // The results and a fresh scan go back to the server.
    const [report] = t.server.state.reports;
    expect(report!.results?.map((r) => r.status)).toEqual(['installed', 'installed']);
    expect(report!.scan).toMatchObject([{ name: 'animate', managed: true }, { name: 'polish', managed: true }]);
  });

  it('never touches a folder of the same name that AgentSync does not manage', async () => {
    const t = await machineWithSkills();
    t.write('.claude/skills/animate/SKILL.md', 'my own animate');

    const result = await t.cli('skills', 'sync', '--json', '--overwrite');

    expect(result.code).toBe(3);
    expect(statuses(result)).toEqual({ animate: 'blocked', polish: 'installed' });
    expect(t.skills.calls.map((call) => call.slice(0, 5))).toEqual([['add', `emil/skills#${sha('1')}`, '--skill', 'polish', '-g']]);
    expect(readFileSync(t.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('my own animate');
  });

  it('blocks on anything at the name, even a folder without a SKILL.md', async () => {
    const t = await machineWithSkills();
    t.write('.agents/skills/polish/notes.txt', 'mine');

    const result = await t.cli('skills', 'sync', '--json');

    expect(statuses(result)).toMatchObject({ polish: 'blocked' });
    expect(readFileSync(t.path('.agents/skills/polish/notes.txt'), 'utf8')).toBe('mine');
  });

  it('adopts a copy from the `skills` lock that is exactly the Pin, without reinstalling it', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    // As if `npx skills add` had put them there: same files and lock, but no AgentSync record.
    const config = JSON.parse(readFileSync(t.path('.config/agentsync/config.json'), 'utf8'));
    delete config.managedSkills;
    t.write('.config/agentsync/config.json', JSON.stringify(config));
    t.skills.calls.length = 0;

    const result = await t.cli('skills', 'sync', '--json');

    expect(result.code).toBe(0);
    expect(statuses(result)).toEqual({ animate: 'adopted', polish: 'adopted' });
    expect(t.skills.calls).toEqual([]);
  });

  it('updates its own copy to a new Pin, but leaves a hand edit until --overwrite', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    const animate2 = await t.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    const polish2 = await t.skills.publish('emil/skills', sha('2'), 'polish', { 'SKILL.md': 'polish v2' });
    t.server.state.skills = [
      { name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: animate2 },
      { name: 'polish', repo: 'emil/skills', commit: sha('2'), installedHash: polish2 },
    ];
    t.write('.agents/skills/polish/SKILL.md', 'polish, edited by hand');

    const kept = await t.cli('skills', 'sync', '--json');
    expect(kept.code).toBe(3);
    expect(statuses(kept)).toEqual({ animate: 'updated', polish: 'drifted' });
    expect(readFileSync(t.path('.agents/skills/polish/SKILL.md'), 'utf8')).toBe('polish, edited by hand');

    const replaced = await t.cli('skills', 'sync', '--json', '--overwrite');
    expect(replaced.code).toBe(0);
    expect(statuses(replaced)).toEqual({ animate: 'unchanged', polish: 'updated' });
    expect(readFileSync(t.path('.agents/skills/polish/SKILL.md'), 'utf8')).toBe('polish v2');
  });

  it('removes only its own undrifted copies of Skills this Machine no longer has', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    t.write('.agents/skills/polish/SKILL.md', 'polish, edited by hand');
    t.write('.agents/skills/handmade/SKILL.md', 'mine');
    t.server.state.skills = [];
    t.skills.calls.length = 0;

    const result = await t.cli('skills', 'sync', '--json');

    expect(result.code).toBe(3);
    expect(statuses(result)).toEqual({ animate: 'removed', polish: 'drifted' });
    expect(t.skills.calls).toEqual([['remove', 'animate', '-g', '-y', '-a', 'claude-code', 'codex', 'pi']]);
    expect(existsSync(t.path('.agents/skills/animate'))).toBe(false);
    expect(existsSync(t.path('.claude/skills/animate'))).toBe(false);
    expect(readFileSync(t.path('.agents/skills/polish/SKILL.md'), 'utf8')).toBe('polish, edited by hand');
    expect(readFileSync(t.path('.agents/skills/handmade/SKILL.md'), 'utf8')).toBe('mine');
  });

  it('fails a Skill whose installed folder does not match its Pin', async () => {
    const t = await machineWithSkills();
    t.server.state.skills[0]!.installedHash = sha('e');

    const result = await t.cli('skills', 'sync', '--json');

    expect(result.code).toBe(1);
    expect(result.json().skills[0]).toMatchObject({ name: 'animate', status: 'failed', error: 'The installed folder does not match its Pin.' });
  });

  it('refuses arguments from the server that the `skills` CLI could read as flags', async () => {
    const t = await machineWithSkills();
    t.server.state.skills = [{ ...t.server.state.skills[0]!, name: '--global' }];

    const result = await t.cli('skills', 'sync', '--json');

    expect(result.code).toBe(1);
    expect(t.skills.calls).toEqual([]);
  });

  it('installs for Claude Code alone as a plain copy in its skills directory', async () => {
    const t = await machineWithSkills();
    t.registered([{ path: '~/.claude/CLAUDE.md', agent: 'claude' }]);

    await t.cli('skills', 'sync');

    expect(t.skills.calls[0]).toContain('claude-code');
    expect(lstatSync(t.path('.claude/skills/animate')).isDirectory()).toBe(true);
    expect((await t.cli('skills', 'sync', '--json')).json().skills.map((s: { status: string }) => s.status)).toEqual(['unchanged', 'unchanged']);
  });
});

describe('the hook and Skills', () => {
  it('says what `skills sync` would do, installs nothing, and reports the scan only when it changed', async () => {
    const t = await machineWithSkills();
    t.server.putTemplate('one\n');
    t.write('.agents/skills/handmade/SKILL.md', 'mine');

    const first = await t.cli('sync', '--hook', 'pi');
    expect(first.stdout).toContain('2 Skills to install; run `agentsync skills sync`');
    expect(t.skills.calls).toEqual([]);
    expect(t.server.state.reports).toHaveLength(1);
    // A hand-written folder is reported by name only.
    expect(t.server.state.reports[0]!.scan).toEqual([{ name: 'handmade', source: null, ref: null, hash: null, managed: false }]);

    await t.cli('sync', '--hook', 'pi');
    expect(t.server.state.reports).toHaveLength(1);

    t.write('.agents/skills/another/SKILL.md', 'mine too');
    await t.cli('sync', '--hook', 'pi');
    expect(t.server.state.reports).toHaveLength(2);
  });

  it('reports an unchanged scan again after a day', async () => {
    const t = await machineWithSkills();
    await t.cli('sync', '--hook', 'pi');
    const config = JSON.parse(readFileSync(t.path('.config/agentsync/config.json'), 'utf8'));
    config.skillsReport.at -= 25 * 60 * 60 * 1000;
    t.write('.config/agentsync/config.json', JSON.stringify(config));

    await t.cli('sync', '--hook', 'pi');

    expect(t.server.state.reports).toHaveLength(2);
  });
});

describe('init and Skills', () => {
  it('adopts what is already installed, then skips the rest without a terminal and prints the command', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    const config = JSON.parse(readFileSync(t.path('.config/agentsync/config.json'), 'utf8'));
    delete config.managedSkills;
    t.write('.config/agentsync/config.json', JSON.stringify(config));
    rmSync(t.path('.agents/skills/polish'), { recursive: true });
    rmSync(t.path('.claude/skills/polish'));
    t.skills.calls.length = 0;

    const result = await t.cli('init', '--agent', 'claude', '--agent', 'codex');

    expect(result.stdout).toContain('2 Skills from your account are set for this Machine (1 already installed).');
    expect(result.stdout).toContain('Run `agentsync skills sync` to install them.');
    expect(t.skills.calls).toEqual([]);
    expect(JSON.parse(readFileSync(t.path('.config/agentsync/config.json'), 'utf8')).managedSkills).toHaveProperty('animate');
  });

  it('installs them with --skills', async () => {
    const t = await machineWithSkills();

    const result = await t.cli('init', '--agent', 'claude', '--agent', 'codex', '--skills', '--json');

    expect(result.code).toBe(0);
    expect(result.json().accountSkills.results.map((r: { status: string }) => r.status)).toEqual(['installed', 'installed']);
  });
});
