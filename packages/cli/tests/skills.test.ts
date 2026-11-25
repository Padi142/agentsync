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
    { name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: animate, sources: ['emil/skills'] },
    { name: 'polish', repo: 'emil/skills', commit: sha('1'), installedHash: polish, sources: ['emil/skills'] },
  ];
  return t;
}

const stateFile = (t: ReturnType<typeof setup>) => t.path('.config/agentsync/skills.json');
const readState = (t: ReturnType<typeof setup>) => JSON.parse(readFileSync(stateFile(t), 'utf8'));
/** Forget AgentSync's records, as if the folders had been installed by hand with `npx skills add`. */
const forgetRecords = (t: ReturnType<typeof setup>) => t.write('.config/agentsync/skills.json', JSON.stringify({ ...readState(t), managed: {} }));

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
    forgetRecords(t);
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
      { name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: animate2, sources: ['emil/skills'] },
      { name: 'polish', repo: 'emil/skills', commit: sha('2'), installedHash: polish2, sources: ['emil/skills'] },
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
    expect(t.skills.calls).toEqual([['remove', 'animate', '-g', '-y', '-a', 'claude-code', 'codex', 'pi', 'antigravity']]);
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
    const state = readState(t);
    state.report.at -= 25 * 60 * 60 * 1000;
    t.write('.config/agentsync/skills.json', JSON.stringify(state));

    await t.cli('sync', '--hook', 'pi');

    expect(t.server.state.reports).toHaveLength(2);
  });
});

describe('init and Skills', () => {
  it('adopts what is already installed, then skips the rest without a terminal and prints the command', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    forgetRecords(t);
    rmSync(t.path('.agents/skills/polish'), { recursive: true });
    rmSync(t.path('.claude/skills/polish'));
    t.skills.calls.length = 0;

    const result = await t.cli('init', '--agent', 'claude', '--agent', 'codex');

    expect(result.stdout).toContain('2 Skills from your account are set for this Machine (1 already installed).');
    expect(result.stdout).toContain('Run `agentsync skills sync` to install them.');
    expect(t.skills.calls).toEqual([]);
    expect(readState(t).managed).toHaveProperty('animate');
  });

  it('installs them with --skills', async () => {
    const t = await machineWithSkills();

    const result = await t.cli('init', '--agent', 'claude', '--agent', 'codex', '--skills', '--json');

    expect(result.code).toBe(0);
    expect(result.json().accountSkills.results.map((r: { status: string }) => r.status)).toEqual(['installed', 'installed']);
  });
});

describe('skills sync only touches what AgentSync owns', () => {
  const codexOnly = [{ path: '~/.codex/AGENTS.md', agent: 'codex' }];

  it('leaves your own copy in another agent’s directory alone, even with --overwrite, and doesn’t remove it', async () => {
    const t = await machineWithSkills();
    t.registered(codexOnly);
    await t.cli('skills', 'sync');
    t.write('.claude/skills/animate/SKILL.md', 'my Claude-only animate');
    t.write('.claude/skills/animate/metadata.json', 'private');
    t.skills.calls.length = 0;

    expect(statuses(await t.cli('skills', 'sync', '--json', '--overwrite'))).toMatchObject({ animate: 'blocked' });
    t.server.state.skills = [];
    expect(statuses(await t.cli('skills', 'sync', '--json', '--overwrite'))).toMatchObject({ animate: 'blocked' });

    expect(t.skills.calls.filter((call) => call.includes('animate'))).toEqual([]);
    expect(readFileSync(t.path('.claude/skills/animate/metadata.json'), 'utf8')).toBe('private');
  });

  it('treats a copy someone reinstalled from another repository as theirs', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    t.skills.lockSource('animate', 'someone/else');
    t.write('.agents/skills/animate/SKILL.md', 'their animate');

    expect(statuses(await t.cli('skills', 'sync', '--json', '--overwrite'))).toMatchObject({ animate: 'blocked' });
    expect(readFileSync(t.path('.agents/skills/animate/SKILL.md'), 'utf8')).toBe('their animate');
  });

  it('never mistakes an inherited property for a record: a skill named `constructor` stays yours', async () => {
    const t = await machineWithSkills();
    const hash = await t.skills.publish('emil/skills', sha('1'), 'constructor', { 'SKILL.md': 'pinned' });
    t.server.state.skills = [{ name: 'constructor', repo: 'emil/skills', commit: sha('1'), installedHash: hash, sources: ['emil/skills'] }];
    t.write('.agents/skills/constructor/SKILL.md', 'mine');

    expect(statuses(await t.cli('skills', 'sync', '--json', '--overwrite'))).toEqual({ constructor: 'blocked' });
    expect(t.skills.calls).toEqual([]);
  });

  it('refuses a name `skills` would install under another name', async () => {
    const t = await machineWithSkills();
    t.write('.agents/skills/animate/SKILL.md', 'mine');
    t.server.state.skills = [{ ...t.server.state.skills[0]!, name: 'animate-' }];

    const result = await t.cli('skills', 'sync', '--json');

    expect(result.code).toBe(1);
    expect(t.skills.calls).toEqual([]);
    expect(readFileSync(t.path('.agents/skills/animate/SKILL.md'), 'utf8')).toBe('mine');
  });

  it('installs the copy a newly added agent needs', async () => {
    const t = await machineWithSkills();
    t.registered(codexOnly);
    await t.cli('skills', 'sync');
    expect(existsSync(t.path('.claude/skills/animate'))).toBe(false);
    t.registered(both);

    const result = await t.cli('skills', 'sync', '--json');

    expect(statuses(result)).toEqual({ animate: 'updated', polish: 'updated' });
    expect(readFileSync(t.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
  });

  it('fails a Skill `skills` reported as failed, even if a copy landed', async () => {
    const t = await machineWithSkills();
    t.skills.failHalfway.add('animate');

    const result = await t.cli('skills', 'sync', '--json');

    expect(result.code).toBe(1);
    expect(result.json().skills.find((s: { name: string }) => s.name === 'animate')).toMatchObject({ status: 'failed', error: 'EACCES: Claude Code link' });
  });

  it('keeps an edit made after a half-finished install, unless --overwrite', async () => {
    const t = await machineWithSkills();
    t.skills.failHalfway.add('animate');
    await t.cli('skills', 'sync');
    t.write('.agents/skills/animate/SKILL.md', 'mine');

    const result = await t.cli('skills', 'sync', '--json');

    expect(statuses(result).animate).toBe('drifted');
    expect(readFileSync(t.path('.agents/skills/animate/SKILL.md'), 'utf8')).toBe('mine');
  });
});

describe('skills found on the Machine', () => {
  it('says how many skills AgentSync does not manage, and where to add them', async () => {
    const t = setup();
    t.registered(both);
    t.write('.agents/skills/mine/SKILL.md', 'mine');
    t.write('.claude/skills/theirs/SKILL.md', 'theirs');

    const result = await t.cli('skills', 'sync');

    expect(result.stdout).toMatch(/Found 2 skills on this Machine that AgentSync doesn't manage\. Sync the ones you want everywhere at https?:\/\/[^ ]+\/skills/);
  });
});

describe('plain sync and Skills', () => {
  it('says what `skills sync` would do, and installs nothing', async () => {
    const t = await machineWithSkills();
    t.server.putTemplate('one\n');

    const result = await t.cli('sync', '--json');

    expect(result.stderr).toContain('Skills: 2 Skills to install; run `agentsync skills sync`.');
    expect(result.json().skills).toEqual({ install: 2, update: 0, remove: 0 });
    expect(t.skills.calls).toEqual([]);
  });
});

describe('skills sync after something went wrong', () => {
  it('retries a failed update, instead of calling the untouched copy hand edited', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    // The new Pin can't be installed (say, the network is down): `skills` skips it.
    t.server.state.skills[0] = { ...t.server.state.skills[0]!, commit: sha('9'), installedHash: sha('e') };

    expect(statuses(await t.cli('skills', 'sync', '--json'))).toMatchObject({ animate: 'failed' });
    expect(statuses(await t.cli('skills', 'sync', '--json'))).toMatchObject({ animate: 'failed' });
    expect((await t.cli('skills', 'status', '--json')).json().skills[0]).toMatchObject({ name: 'animate', state: 'update' });
  });

  it('finishes a removal `skills` leaves half done because another agent reads ~/.agents/skills', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    t.write('.cursor/settings.json', '{}');
    t.server.state.skills = [];

    const result = await t.cli('skills', 'sync', '--json');

    expect(statuses(result)).toEqual({ animate: 'removed', polish: 'removed' });
    expect(existsSync(t.path('.agents/skills/animate'))).toBe(false);
    expect(JSON.parse(readFileSync(t.path('.agents/.skill-lock.json'), 'utf8')).skills).toEqual({});
  });

  it('treats a copy from a lock entry that isn’t GitHub as someone else’s', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    const lock = JSON.parse(readFileSync(t.path('.agents/.skill-lock.json'), 'utf8'));
    lock.skills.animate = { source: './my-animate', sourceType: 'local' };
    t.write('.agents/.skill-lock.json', JSON.stringify(lock));
    t.write('.agents/skills/animate/SKILL.md', 'my local animate');

    expect(statuses(await t.cli('skills', 'sync', '--json', '--overwrite'))).toMatchObject({ animate: 'blocked' });
    expect(readFileSync(t.path('.agents/skills/animate/SKILL.md'), 'utf8')).toBe('my local animate');
  });

  it('never installs a Skill over its own agentsync skill', async () => {
    const t = await machineWithSkills();
    t.server.state.skills = [{ ...t.server.state.skills[0]!, name: 'agentsync' }];

    await t.cli('skills', 'sync', '--json');

    expect(t.skills.calls).toEqual([]);
  });

  it('takes over a lock left by a run that died, but not one a running sync holds', async () => {
    const t = await machineWithSkills();
    t.write('.config/agentsync/skills.lock', String(process.pid));
    expect((await t.cli('skills', 'sync')).stderr).toContain('Another `agentsync skills sync` is running');
    t.write('.config/agentsync/skills.lock', '999999999');
    expect((await t.cli('skills', 'sync')).code).toBe(0);
  });
});

describe('finishing a removal', () => {
  it('leaves the shared copy if it was edited after skills sync looked at it', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    t.write('.cursor/settings.json', '{}');
    t.server.state.skills = [];
    // An edit lands while `skills remove` runs.
    const run = t.skills.run;
    t.skills.run = async (args) => {
      const done = await run(args);
      if (args[0] === 'remove') t.write('.agents/skills/animate/SKILL.md', 'edited meanwhile');
      return done;
    };

    const result = await t.cli('skills', 'sync', '--json');

    expect(statuses(result)).toMatchObject({ animate: 'failed', polish: 'removed' });
    expect(readFileSync(t.path('.agents/skills/animate/SKILL.md'), 'utf8')).toBe('edited meanwhile');
  });
});

describe('skills add', () => {
  /** `animate` and `polish` set for the Machine already; `team/kit` offers `animate` (already set) and `motion`. */
  async function machineWithRequestable() {
    const t = await machineWithSkills();
    const motion = await t.skills.publish('team/kit', sha('2'), 'motion', { 'SKILL.md': 'motion v1' });
    const proposed = (name: string, installedHash: string) => ({
      name, path: `skills/${name}`, conflict: null,
      pin: { commit: sha('2'), treeSha: sha('3'), installedHash, committedAt: new Date() },
      audits: { gen: null, socket: null, snyk: null },
    });
    t.server.state.repoSkills.set('team/kit', [proposed('motion', motion)]);
    return { t, motion };
  }

  it('asks once, prints the link, and resumes the same request when run again', async () => {
    const { t } = await machineWithRequestable();
    t.server.state.readingCalls = 2;

    const first = await t.cli('skills', 'add', 'https://github.com/team/kit', '--no-wait', '--json');
    expect(first.code).toBe(6);
    expect(first.json()).toMatchObject({ ok: false, status: 'pending', request: { repo: 'team/kit', skills: ['motion'], resumed: false } });
    expect(first.stderr).toContain(first.json().request.url);

    const again = await t.cli('skills', 'add', 'team/kit', '--no-wait', '--json');
    expect(again.json().request).toMatchObject({ id: first.json().request.id, resumed: true });
    expect(t.server.state.skillRequests.size).toBe(1);
    expect(t.skills.calls).toEqual([]);
  });

  it('fails as a usage error on a name the repository lacks, listing what it has', async () => {
    const { t } = await machineWithRequestable();
    const result = await t.cli('skills', 'add', 'team/kit', 'nope', '--json');
    expect(result.code).toBe(2);
    expect(result.json().error).toMatchObject({ unknown: ['nope'], available: ['motion'] });
    expect(t.server.state.skillRequests.size).toBe(0);
  });

  it('waits for approval, then installs only what was approved, leaving other pending Skills alone', async () => {
    const { t, motion } = await machineWithRequestable();
    t.server.state.skills.push({ name: 'motion', repo: 'team/kit', commit: sha('2'), installedHash: motion, sources: ['team/kit'] });
    t.server.state.decideAfter = { polls: 2, status: 'approved', added: ['motion'] };

    const result = await t.cli('skills', 'add', 'team/kit', '--json');

    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ status: 'approved', added: ['motion'], skills: [{ name: 'motion', status: 'installed' }] });
    expect(t.skills.calls).toEqual([['add', `team/kit#${sha('2')}`, '--skill', 'motion', '-g', '-a', 'claude-code', 'codex', '-y', '--json']]);
    // Only motion's result is sent, marked partial, so the server keeps what it knew of the others.
    expect(t.server.state.reports.at(-1)).toMatchObject({ partial: true, results: [{ name: 'motion', status: 'installed' }] });
  });

  it('warns about a hand-installed copy, then reports it blocked after approval', async () => {
    const { t, motion } = await machineWithRequestable();
    t.write('.claude/skills/motion/SKILL.md', 'my own motion');
    t.server.state.skills.push({ name: 'motion', repo: 'team/kit', commit: sha('2'), installedHash: motion, sources: ['team/kit'] });
    t.server.state.decideAfter = { polls: 1, status: 'approved', added: ['motion'] };

    const result = await t.cli('skills', 'add', 'team/kit', '--json');

    expect(result.stderr).toContain('motion is already on this Machine, installed outside AgentSync');
    expect(result.code).toBe(3);
    expect(statuses(result)).toEqual({ motion: 'blocked' });
    expect(readFileSync(t.path('.claude/skills/motion/SKILL.md'), 'utf8')).toBe('my own motion');
  });

  it('exits 1 when rejected, and 6 when nobody decides within the wait', async () => {
    const { t } = await machineWithRequestable();
    t.server.state.decideAfter = { polls: 1, status: 'rejected', added: [] };
    const rejected = await t.cli('skills', 'add', 'team/kit', '--json');
    expect(rejected.code).toBe(1);
    expect(rejected.json().error.message).toContain('rejected');

    t.server.state.repoSkills.set('team/other', t.server.state.repoSkills.get('team/kit')!);
    const waited = await t.cli('skills', 'add', 'team/other', '--json');
    expect(waited.code).toBe(6);
    expect(t.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });
});

describe('Antigravity and multiple Claude Code instances', () => {
  it('installs, keeps in sync, and removes Skills for Antigravity alongside other agents', async () => {
    const t = await machineWithSkills();
    t.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/.gemini/config/AGENTS.md', agent: 'antigravity' },
    ]);

    const installed = await t.cli('skills', 'sync', '--json');
    expect(installed.code).toBe(0);
    expect(t.skills.calls).toEqual([
      ['add', `emil/skills#${sha('1')}`, '--skill', 'animate', 'polish', '-g', '-a', 'claude-code', 'antigravity', '-y', '--json'],
    ]);
    expect(readFileSync(t.path('.gemini/config/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
    expect(readFileSync(t.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // Second sync sees both copies and makes no changes.
    t.skills.calls.length = 0;
    const second = await t.cli('skills', 'sync', '--json');
    expect(second.code).toBe(0);
    expect(statuses(second)).toEqual({ animate: 'unchanged', polish: 'unchanged' });
    expect(t.skills.calls).toEqual([]);

    // Removing deletes Antigravity's symlink too.
    t.server.state.skills = [];
    const removed = await t.cli('skills', 'sync', '--json');
    expect(removed.code).toBe(0);
    expect(statuses(removed)).toEqual({ animate: 'removed', polish: 'removed' });
    expect(existsSync(t.path('.gemini/config/skills/animate'))).toBe(false);
    expect(existsSync(t.path('.claude/skills/animate'))).toBe(false);
  });

  it('blocks on a hand-written skill in ~/.gemini/config/skills even when Antigravity is not a Target', async () => {
    const t = await machineWithSkills();
    t.write('.gemini/config/skills/animate/SKILL.md', 'my own antigravity animate');

    const result = await t.cli('skills', 'sync', '--json', '--overwrite');

    expect(result.code).toBe(3);
    expect(statuses(result)).toEqual({ animate: 'blocked', polish: 'installed' });
    expect(readFileSync(t.path('.gemini/config/skills/animate/SKILL.md'), 'utf8')).toBe('my own antigravity animate');
  });

  it('installs, blocks, updates and removes Skills across multiple Claude Code instances even with CLAUDE_CONFIG_DIR set', async () => {
    const t = setup({ env: { CLAUDE_CONFIG_DIR: '~/.claude_personal' } });
    const animate = await t.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const polish = await t.skills.publish('emil/skills', sha('1'), 'polish', { 'SKILL.md': 'polish v1' });
    t.server.state.skills = [
      { name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: animate, sources: ['emil/skills'] },
      { name: 'polish', repo: 'emil/skills', commit: sha('1'), installedHash: polish, sources: ['emil/skills'] },
    ];
    t.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/.claude_personal/CLAUDE.md', agent: 'claude' },
      { path: '~/.codex/AGENTS.md', agent: 'codex' },
    ]);
    t.write('.claude_personal/skills/polish/SKILL.md', 'personal hand-written polish');

    const result = await t.cli('skills', 'sync', '--json');
    expect(result.code).toBe(3);
    expect(statuses(result)).toEqual({ animate: 'installed', polish: 'blocked' });
    expect(readFileSync(t.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
    expect(readFileSync(t.path('.claude_personal/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
    expect(readFileSync(t.path('.agents/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
    expect(readFileSync(t.path('.claude_personal/skills/polish/SKILL.md'), 'utf8')).toBe('personal hand-written polish');
    expect(t.skills.invocations).toEqual([
      {
        args: ['add', `emil/skills#${sha('1')}`, '--skill', 'animate', '-g', '-a', 'claude-code', 'codex', '-y', '--json'],
        env: { CLAUDE_CONFIG_DIR: t.path('.claude') },
      },
      {
        args: ['add', `emil/skills#${sha('1')}`, '--skill', 'animate', '-g', '-a', 'claude-code', '-y', '--json'],
        env: { CLAUDE_CONFIG_DIR: t.path('.claude_personal') },
      },
    ]);

    // Removing animate removes it from both Claude Code instances and ~/.agents/skills.
    t.server.state.skills = [];
    t.skills.invocations.length = 0;
    const removed = await t.cli('skills', 'sync', '--json');
    expect(removed.code).toBe(0);
    expect(statuses(removed)).toEqual({ animate: 'removed' });
    expect(existsSync(t.path('.claude/skills/animate'))).toBe(false);
    expect(existsSync(t.path('.claude_personal/skills/animate'))).toBe(false);
    expect(existsSync(t.path('.agents/skills/animate'))).toBe(false);
  });

  it('fills in a newly added Claude Code instance and Antigravity copy on the next skills sync', async () => {
    const t = await machineWithSkills();
    await t.cli('skills', 'sync');
    // Now add ~/.claude_personal and Antigravity to the registered Machine.
    const [machine] = t.server.state.machines.values();
    machine!.targets.push(
      { path: '~/.claude_personal/CLAUDE.md', agent: 'claude' },
      { path: '~/.gemini/config/AGENTS.md', agent: 'antigravity' },
    );

    const updated = await t.cli('skills', 'sync', '--json');
    expect(updated.code).toBe(0);
    expect(statuses(updated)).toEqual({ animate: 'updated', polish: 'updated' });
    expect(readFileSync(t.path('.claude_personal/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
    expect(readFileSync(t.path('.gemini/config/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
  });
});
