import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
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

  it('migrates legacy "claude" ownership for a custom CLAUDE_CONFIG_DIR even after ~/.claude is added, without claiming unregistered copies', async () => {
    const t = setup();
    const v1 = await t.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const v2 = await t.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    t.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/.claude_custom/CLAUDE.md', agent: 'claude' },
    ]);
    t.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: v1, sources: ['emil/skills'] }];
    await t.cli('skills', 'sync');

    // Simulate pre-upgrade skills.json (no schema version) that recorded ~/.claude_custom as "claude".
    // Run one sync BEFORE registering ~/.claude_custom (so version: 2 is written while the legacy entry
    // is still blocked/unmatched), then register TWO custom Claude homes (~/.claude_custom, ~/.claude_other)
    // and verify the legacy record still migrates uniquely to ~/.claude_custom.
    rmSync(t.path('.claude/skills/animate'), { recursive: true, force: true });
    const legacy = readState(t);
    delete legacy.version;
    delete legacy.places;
    legacy.managed.animate.places = ['claude'];
    delete legacy.managed.animate.placeDirs;
    t.write('.config/agentsync/skills.json', JSON.stringify(legacy));
    const [machine] = t.server.state.machines.values();
    machine!.targets = [{ path: '~/.claude/CLAUDE.md', agent: 'claude' }];
    t.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: v2, sources: ['emil/skills'] }];
    // Before ~/.claude_custom is registered, the copy stays blocked and version 2 preserves legacyClaude.
    expect((await t.cli('skills', 'sync', '--json')).code).toBe(3);
    expect(readState(t).version).toBe(2);
    expect(readState(t).managed.animate.legacyClaude).toBe(true);

    // Register both ~/.claude_custom (which holds the matching copy) and ~/.claude_other (which does not).
    machine!.targets = [
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/.claude_custom/CLAUDE.md', agent: 'claude' },
      { path: '~/.claude_other/CLAUDE.md', agent: 'claude' },
    ];
    const updated = await t.cli('skills', 'sync', '--json');
    expect(updated.code).toBe(0);
    expect(statuses(updated)).toEqual({ animate: 'updated' });
    expect(readFileSync(t.path('.claude_custom/skills/animate/SKILL.md'), 'utf8')).toBe('animate v2');
    expect(readFileSync(t.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v2');
    expect(readFileSync(t.path('.claude_other/skills/animate/SKILL.md'), 'utf8')).toBe('animate v2');
    expect(readState(t).managed.animate.legacyClaude).toBeUndefined();

    // A version-2 record for ~/.claude must NEVER claim or delete a copy in an unregistered CLAUDE_CONFIG_DIR.
    const t2 = setup({ env: { CLAUDE_CONFIG_DIR: '~/unregistered-claude' } });
    const h = await t2.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t2.registered([{ path: '~/.claude/CLAUDE.md', agent: 'claude' }]);
    t2.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: h, sources: ['emil/skills'] }];
    await t2.cli('skills', 'sync');
    rmSync(t2.path('.claude/skills/animate'), { recursive: true, force: true });
    t2.write('unregistered-claude/skills/animate/SKILL.md', 'animate v1');
    t2.server.state.skills = [];
    const blocked = await t2.cli('skills', 'sync', '--json');
    expect(blocked.code).toBe(3);
    expect(statuses(blocked)).toEqual({ animate: 'blocked' });
    expect(readFileSync(t2.path('unregistered-claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // A legacy custom-home record must NOT delete an independent copy in unregistered ~/.claude,
    // even when the custom home's copy is missing and CLAUDE_CONFIG_DIR points to the custom home.
    const t3 = setup({ env: { CLAUDE_CONFIG_DIR: '~/profiles/personal' } });
    const h3 = await t3.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t3.registered([{ path: '~/profiles/personal/CLAUDE.md', agent: 'claude' }]);
    t3.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: h3, sources: ['emil/skills'] }];
    await t3.cli('skills', 'sync');
    const legacy3 = readState(t3);
    delete legacy3.version;
    delete legacy3.places;
    legacy3.managed.animate.places = ['claude'];
    delete legacy3.managed.animate.placeDirs;
    t3.write('.config/agentsync/skills.json', JSON.stringify(legacy3));
    rmSync(t3.path('profiles/personal/skills/animate'), { recursive: true, force: true });
    t3.write('.claude/skills/animate/SKILL.md', 'animate v1');
    t3.server.state.skills = [];
    const safeRemove = await t3.cli('skills', 'sync', '--json');
    expect(safeRemove.code).toBe(3);
    expect(statuses(safeRemove)).toEqual({ animate: 'blocked' });
    expect(readFileSync(t3.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // A failed initial scan must NOT stamp version: 2 before legacy migration runs.
    const t4 = setup();
    const h4 = await t4.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const h4v2 = await t4.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    t4.registered([{ path: '~/profiles/personal/CLAUDE.md', agent: 'claude' }]);
    t4.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: h4, sources: ['emil/skills'] }];
    await t4.cli('skills', 'sync');
    const legacy4 = readState(t4);
    delete legacy4.version;
    delete legacy4.places;
    legacy4.managed.animate.places = ['claude'];
    delete legacy4.managed.animate.placeDirs;
    t4.write('.config/agentsync/skills.json', JSON.stringify(legacy4));
    t4.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: h4v2, sources: ['emil/skills'] }];
    chmodSync(t4.path('profiles/personal/skills/animate/SKILL.md'), 0o000);
    try {
      expect((await t4.cli('skills', 'sync', '--json')).code).not.toBe(0);
      expect(readState(t4).version).toBeUndefined();
    } finally {
      chmodSync(t4.path('profiles/personal/skills/animate/SKILL.md'), 0o644);
    }
    const recovered = await t4.cli('skills', 'sync', '--json');
    expect(recovered.code).toBe(0);
    expect(statuses(recovered)).toEqual({ animate: 'updated' });
    expect(readFileSync(t4.path('profiles/personal/skills/animate/SKILL.md'), 'utf8')).toBe('animate v2');

    // Even when BOTH ~/.claude and ~/profiles/personal are registered, CLAUDE_CONFIG_DIR points to the
    // custom home, and --overwrite is passed, an independent copy in ~/.claude must NOT be deleted.
    const t5 = setup({ env: { CLAUDE_CONFIG_DIR: '~/profiles/personal' } });
    const h5 = await t5.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t5.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/profiles/personal/CLAUDE.md', agent: 'claude' },
    ]);
    t5.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: h5, sources: ['emil/skills'] }];
    await t5.cli('skills', 'sync');
    const legacy5 = readState(t5);
    delete legacy5.version;
    delete legacy5.places;
    legacy5.managed.animate.places = ['claude'];
    delete legacy5.managed.animate.placeDirs;
    t5.write('.config/agentsync/skills.json', JSON.stringify(legacy5));
    rmSync(t5.path('profiles/personal/skills/animate'), { recursive: true, force: true });
    t5.write('.claude/skills/animate/SKILL.md', 'my independent copy');
    t5.server.state.skills = [];
    const safeOverwrite = await t5.cli('skills', 'sync', '--overwrite', '--json');
    expect(safeOverwrite.code).toBe(3);
    expect(statuses(safeOverwrite)).toEqual({ animate: 'blocked' });
    expect(readFileSync(t5.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('my independent copy');

    // An unchanged sync on a legacy ['agents', 'claude'] record (with only Codex registered and only
    // ~/.agents/skills present) must keep legacyClaude so an independent ~/.claude copy is never deleted.
    const t6 = setup();
    const h6 = await t6.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t6.registered([{ path: '~/.codex/AGENTS.md', agent: 'codex' }]);
    t6.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: h6, sources: ['emil/skills'] }];
    await t6.cli('skills', 'sync');
    const legacy6 = readState(t6);
    delete legacy6.version;
    delete legacy6.places;
    legacy6.managed.animate.places = ['agents', 'claude'];
    delete legacy6.managed.animate.placeDirs;
    t6.write('.config/agentsync/skills.json', JSON.stringify(legacy6));
    expect(statuses(await t6.cli('skills', 'sync', '--json'))).toEqual({ animate: 'unchanged' });
    expect(readState(t6).managed.animate.legacyClaude).toBe(true);
    t6.write('.claude/skills/animate/SKILL.md', 'my independent copy');
    t6.server.state.skills = [];
    const safeCodexRemove = await t6.cli('skills', 'sync', '--overwrite', '--json');
    expect(safeCodexRemove.code).toBe(3);
    expect(statuses(safeCodexRemove)).toEqual({ animate: 'blocked' });
    expect(readFileSync(t6.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('my independent copy');

    // Matching copies in both ~/.claude and detected ~/.claude_work mark the legacy record ambiguous so
    // moving ~/.claude_work outside discovery later still does not delete the independent ~/.claude copy.
    const t7 = setup();
    const h7 = await t7.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t7.registered([{ path: '~/.claude/CLAUDE.md', agent: 'claude' }]);
    t7.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: h7, sources: ['emil/skills'] }];
    await t7.cli('skills', 'sync');
    t7.write('.claude_work/settings.json', '{}');
    t7.write('.claude_work/skills/animate/SKILL.md', 'animate v1');
    const legacy7 = readState(t7);
    delete legacy7.version;
    delete legacy7.places;
    legacy7.managed.animate.places = ['claude'];
    delete legacy7.managed.animate.placeDirs;
    t7.write('.config/agentsync/skills.json', JSON.stringify(legacy7));
    t7.server.state.skills = [];
    expect(statuses(await t7.cli('skills', 'sync', '--json'))).toEqual({ animate: 'blocked' });
    expect(readState(t7).managed.animate.legacyClaude).toBe('ambiguous');
    rmSync(t7.path('.claude_work'), { recursive: true, force: true });
    expect(statuses(await t7.cli('skills', 'sync', '--json'))).toEqual({ animate: 'blocked' });
    expect(readFileSync(t7.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // Even if a third detected copy is missing SKILL.md (suppressing per-place hashes), ambiguity is still
    // recorded so moving both other homes outside discovery later never deletes the independent ~/.claude copy.
    const t7b = setup();
    const h7b = await t7b.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t7b.registered([{ path: '~/.claude/CLAUDE.md', agent: 'claude' }]);
    t7b.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: h7b, sources: ['emil/skills'] }];
    await t7b.cli('skills', 'sync');
    t7b.write('.claude_work/settings.json', '{}');
    t7b.write('.claude_work/skills/animate/SKILL.md', 'animate v1');
    t7b.write('.claude_broken/settings.json', '{}');
    t7b.write('.claude_broken/skills/animate/notes.txt', 'no skill md');
    const legacy7b = readState(t7b);
    delete legacy7b.version;
    delete legacy7b.places;
    legacy7b.managed.animate.places = ['claude'];
    delete legacy7b.managed.animate.placeDirs;
    t7b.write('.config/agentsync/skills.json', JSON.stringify(legacy7b));
    t7b.server.state.skills = [];
    expect(statuses(await t7b.cli('skills', 'sync', '--json'))).toEqual({ animate: 'blocked' });
    expect(readState(t7b).managed.animate.legacyClaude).toBe('ambiguous');
    rmSync(t7b.path('.claude_work'), { recursive: true, force: true });
    rmSync(t7b.path('.claude_broken'), { recursive: true, force: true });
    expect(statuses(await t7b.cli('skills', 'sync', '--json'))).toEqual({ animate: 'blocked' });
    expect(readFileSync(t7b.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // A registered legacy custom Claude home whose skills/ links to ~/.gemini/config/skills migrates cleanly.
    const t8 = setup({ env: { CLAUDE_CONFIG_DIR: '~/profiles/personal' } });
    const h8v1 = await t8.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const h8v2 = await t8.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    t8.write('profiles/personal/settings.json', '{}');
    symlinkSync(t8.path('.gemini/config/skills'), t8.path('profiles/personal/skills'));
    t8.registered([{ path: '~/profiles/personal/CLAUDE.md', agent: 'claude' }]);
    t8.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: h8v1, sources: ['emil/skills'] }];
    await t8.cli('skills', 'sync');
    const legacy8 = readState(t8);
    delete legacy8.version;
    delete legacy8.places;
    legacy8.managed.animate.places = ['claude'];
    delete legacy8.managed.animate.placeDirs;
    t8.write('.config/agentsync/skills.json', JSON.stringify(legacy8));
    t8.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: h8v2, sources: ['emil/skills'] }];
    const migratedAntigravity = await t8.cli('skills', 'sync', '--json');
    expect(migratedAntigravity.code).toBe(0);
    expect(statuses(migratedAntigravity)).toEqual({ animate: 'updated' });
    expect(readFileSync(t8.path('.gemini/config/skills/animate/SKILL.md'), 'utf8')).toBe('animate v2');

    // Legacy migration must NOT claim a symlinked ~/.claude/skills pointing to an independent library.
    const t9 = setup();
    const h9 = await t9.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t9.registered([{ path: '~/.claude/CLAUDE.md', agent: 'claude' }]);
    t9.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: h9, sources: ['emil/skills'] }];
    await t9.cli('skills', 'sync');
    rmSync(t9.path('.claude/skills'), { recursive: true, force: true });
    t9.write('independent-lib/animate/SKILL.md', 'animate v1');
    symlinkSync(t9.path('independent-lib'), t9.path('.claude/skills'));
    const legacy9 = readState(t9);
    delete legacy9.version;
    delete legacy9.places;
    legacy9.managed.animate.places = ['claude'];
    delete legacy9.managed.animate.placeDirs;
    t9.write('.config/agentsync/skills.json', JSON.stringify(legacy9));
    t9.server.state.skills = [];
    const safeSymlinkDefault = await t9.cli('skills', 'sync', '--json');
    expect(safeSymlinkDefault.code).toBe(3);
    expect(statuses(safeSymlinkDefault)).toEqual({ animate: 'blocked' });
    expect(readFileSync(t9.path('independent-lib/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // Legacy default ~/.claude target symlinked to ~/.agents/skills must NOT be treated as a custom migration target.
    const t10 = setup();
    const h10 = await t10.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t10.registered([{ path: '~/.claude/CLAUDE.md', agent: 'claude' }]);
    t10.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: h10, sources: ['emil/skills'] }];
    await t10.cli('skills', 'sync');
    rmSync(t10.path('.claude/skills'), { recursive: true, force: true });
    t10.write('.agents/skills/animate/SKILL.md', 'animate v1');
    symlinkSync(t10.path('.agents/skills'), t10.path('.claude/skills'));
    const legacy10 = readState(t10);
    delete legacy10.version;
    delete legacy10.places;
    legacy10.managed.animate.places = ['claude'];
    delete legacy10.managed.animate.placeDirs;
    t10.write('.config/agentsync/skills.json', JSON.stringify(legacy10));
    t10.server.state.skills = [];
    const safeDefaultToAgents = await t10.cli('skills', 'sync', '--json');
    expect(safeDefaultToAgents.code).toBe(3);
    expect(statuses(safeDefaultToAgents)).toEqual({ animate: 'blocked' });
    expect(readFileSync(t10.path('.agents/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // S37: A registered custom Claude home must NOT claim an independent ~/.agents/skills copy when
    // both it and ~/.claude point to ~/.agents/skills.
    t10.write('profiles/personal/settings.json', '{}');
    symlinkSync(t10.path('.agents/skills'), t10.path('profiles/personal/skills'));
    t10.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/profiles/personal/CLAUDE.md', agent: 'claude' },
    ]);
    t10.write('.config/agentsync/skills.json', JSON.stringify(legacy10));
    const safeBothToAgents = await t10.cli('skills', 'sync', '--json');
    expect(safeBothToAgents.code).toBe(3);
    expect(statuses(safeBothToAgents)).toEqual({ animate: 'blocked' });
    expect(readFileSync(t10.path('.agents/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
  });

  it('canonicalizes a registered symlink pointing to ~/.claude or to a detected custom Claude home', async () => {
    const t = setup();
    const v1 = await t.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const v2 = await t.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    t.write('.claude/settings.json', '{}');
    t.write('.claude_work/settings.json', '{}');
    symlinkSync(t.path('.claude'), t.path('linked-profile'));
    symlinkSync(t.path('.claude_work'), t.path('work-alias'));
    t.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/linked-profile/CLAUDE.md', agent: 'claude' },
      { path: '~/work-alias/CLAUDE.md', agent: 'claude' },
    ]);
    t.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: v1, sources: ['emil/skills'] }];
    expect((await t.cli('skills', 'sync', '--json')).code).toBe(0);
    // Second sync sees no missing copy and makes no calls.
    t.skills.calls.length = 0;
    const steady = await t.cli('skills', 'sync', '--json');
    expect(steady.code).toBe(0);
    expect(statuses(steady)).toEqual({ animate: 'unchanged' });
    expect(t.skills.calls).toEqual([]);

    t.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: v2, sources: ['emil/skills'] }];
    const updated = await t.cli('skills', 'sync', '--json');
    expect(updated.code).toBe(0);
    expect(statuses(updated)).toEqual({ animate: 'updated' });
    expect(readFileSync(t.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v2');
    expect(readFileSync(t.path('.claude_work/skills/animate/SKILL.md'), 'utf8')).toBe('animate v2');

    // Two registered Claude homes sharing a symlinked `skills/` directory (even before target exists).
    const t2 = setup();
    const s1 = await t2.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t2.write('.claude/settings.json', '{}');
    t2.write('profiles/personal/settings.json', '{}');
    symlinkSync(t2.path('.claude/skills'), t2.path('profiles/personal/skills'));
    t2.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/profiles/personal/CLAUDE.md', agent: 'claude' },
    ]);
    t2.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s1, sources: ['emil/skills'] }];
    const shared = await t2.cli('skills', 'sync', '--json');
    expect(shared.code).toBe(0);
    expect(statuses(shared)).toEqual({ animate: 'installed' });
    expect(readFileSync(t2.path('profiles/personal/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
    t2.skills.calls.length = 0;
    const sharedSteady = await t2.cli('skills', 'sync', '--json');
    expect(sharedSteady.code).toBe(0);
    expect(statuses(sharedSteady)).toEqual({ animate: 'unchanged' });
    expect(t2.skills.calls).toEqual([]);

    // Claude-only machine with ~/.claude/skills symlinked directly to ~/.agents/skills.
    const t3 = setup();
    const s3 = await t3.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t3.write('.claude/settings.json', '{}');
    symlinkSync(t3.path('.agents/skills'), t3.path('.claude/skills'));
    t3.registered([{ path: '~/.claude/CLAUDE.md', agent: 'claude' }]);
    t3.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s3, sources: ['emil/skills'] }];
    const claudeToAgents = await t3.cli('skills', 'sync', '--json');
    expect(claudeToAgents.code).toBe(0);
    expect(statuses(claudeToAgents)).toEqual({ animate: 'installed' });
    expect(readFileSync(t3.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // Switching the registered alias between two profiles pointing at the same ~/shared-library stays owned.
    const t4 = setup();
    const s4v1 = await t4.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const s4v2 = await t4.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    t4.write('shared-library/.keep', '');
    t4.write('profiles/a/settings.json', '{}');
    t4.write('profiles/b/settings.json', '{}');
    symlinkSync(t4.path('shared-library'), t4.path('profiles/a/skills'));
    symlinkSync(t4.path('shared-library'), t4.path('profiles/b/skills'));
    t4.registered([{ path: '~/profiles/a/CLAUDE.md', agent: 'claude' }]);
    t4.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s4v1, sources: ['emil/skills'] }];
    expect((await t4.cli('skills', 'sync', '--json')).code).toBe(0);

    // Switch registration to profile B and delete profile A: B still owns ~/shared-library cleanly.
    t4.registered([{ path: '~/profiles/b/CLAUDE.md', agent: 'claude' }]);
    rmSync(t4.path('profiles/a'), { recursive: true, force: true });
    const switchedSteady = await t4.cli('skills', 'sync', '--json');
    expect(switchedSteady.code).toBe(0);
    expect(statuses(switchedSteady)).toEqual({ animate: 'unchanged' });

    t4.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: s4v2, sources: ['emil/skills'] }];
    const switchedUpdated = await t4.cli('skills', 'sync', '--json');
    expect(switchedUpdated.code).toBe(0);
    expect(statuses(switchedUpdated)).toEqual({ animate: 'updated' });
    expect(readFileSync(t4.path('shared-library/animate/SKILL.md'), 'utf8')).toBe('animate v2');

    // Repointing the alias to a DIFFERENT library with identical contents must block removal, not delete it.
    t4.write('other-library/animate/SKILL.md', 'animate v2');
    rmSync(t4.path('profiles/b/skills'), { recursive: true, force: true });
    symlinkSync(t4.path('other-library'), t4.path('profiles/b/skills'));
    t4.server.state.skills = [];
    const repointedBlocked = await t4.cli('skills', 'sync', '--json');
    expect(repointedBlocked.code).toBe(3);
    expect(statuses(repointedBlocked)).toEqual({ animate: 'blocked' });
    expect(readFileSync(t4.path('other-library/animate/SKILL.md'), 'utf8')).toBe('animate v2');

    // Even a record lacking placeDirs must not follow a repointed symlink alias to delete an independent copy.
    const noDirs = readState(t4);
    delete noDirs.managed.animate.placeDirs;
    t4.write('.config/agentsync/skills.json', JSON.stringify(noDirs));
    const repointedNoDirs = await t4.cli('skills', 'sync', '--json');
    expect(repointedNoDirs.code).toBe(3);
    expect(statuses(repointedNoDirs)).toEqual({ animate: 'blocked' });
    expect(readFileSync(t4.path('other-library/animate/SKILL.md'), 'utf8')).toBe('animate v2');

    // Updating via registered profile B must NOT write into an unregistered repointed alias A,
    // and deleting the last alias before unpinning still removes the copy in ~/shared-library.
    const t5 = setup();
    const s5v1 = await t5.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const s5v2 = await t5.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    t5.write('shared-library/.keep', '');
    t5.write('empty-library/.keep', '');
    t5.write('profiles/a/settings.json', '{}');
    t5.write('profiles/b/settings.json', '{}');
    symlinkSync(t5.path('shared-library'), t5.path('profiles/a/skills'));
    symlinkSync(t5.path('shared-library'), t5.path('profiles/b/skills'));
    t5.registered([{ path: '~/profiles/a/CLAUDE.md', agent: 'claude' }]);
    t5.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s5v1, sources: ['emil/skills'] }];
    expect((await t5.cli('skills', 'sync', '--json')).code).toBe(0);
    // Repoint unregistered profile A to empty-library, switch registration to B, and update to v2.
    rmSync(t5.path('profiles/a/skills'), { recursive: true, force: true });
    symlinkSync(t5.path('empty-library'), t5.path('profiles/a/skills'));
    t5.registered([{ path: '~/profiles/b/CLAUDE.md', agent: 'claude' }]);
    t5.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: s5v2, sources: ['emil/skills'] }];
    expect(statuses(await t5.cli('skills', 'sync', '--json'))).toEqual({ animate: 'updated' });
    expect(readFileSync(t5.path('shared-library/animate/SKILL.md'), 'utf8')).toBe('animate v2');
    expect(existsSync(t5.path('empty-library/animate'))).toBe(false);
    // Delete profile B (the last alias pointing to shared-library) before unpinning: still removes cleanly.
    rmSync(t5.path('profiles/b'), { recursive: true, force: true });
    t5.server.state.skills = [];
    const removedOrphan = await t5.cli('skills', 'sync', '--json');
    expect(removedOrphan.code).toBe(0);
    expect(statuses(removedOrphan)).toEqual({ animate: 'removed' });
    expect(existsSync(t5.path('shared-library/animate'))).toBe(false);
    expect(readState(t5).managed.animate).toBeUndefined();

    // An unchanged sync must NOT backfill placeDirs from an empty, repointed alias on a record lacking placeDirs,
    // and updating via a new profile after deleting the last alias cleans up the orphaned canonical copy.
    const t6 = setup();
    const s6v1 = await t6.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const s6v2 = await t6.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    t6.write('shared-library/.keep', '');
    t6.write('empty-library/.keep', '');
    t6.write('profiles/a/settings.json', '{}');
    t6.write('profiles/b/settings.json', '{}');
    t6.write('profiles/c/settings.json', '{}');
    t6.registered([
      { path: '~/profiles/a/CLAUDE.md', agent: 'claude' },
      { path: '~/profiles/b/CLAUDE.md', agent: 'claude' },
    ]);
    t6.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s6v1, sources: ['emil/skills'] }];
    expect((await t6.cli('skills', 'sync', '--json')).code).toBe(0);
    // Strip placeDirs, repoint unregistered profile A to empty-library, run unchanged sync, then update to v2.
    const noPlaceDirs6 = readState(t6);
    delete noPlaceDirs6.managed.animate.placeDirs;
    t6.write('.config/agentsync/skills.json', JSON.stringify(noPlaceDirs6));
    rmSync(t6.path('profiles/a/skills'), { recursive: true, force: true });
    symlinkSync(t6.path('empty-library'), t6.path('profiles/a/skills'));
    t6.registered([{ path: '~/profiles/b/CLAUDE.md', agent: 'claude' }]);
    expect(statuses(await t6.cli('skills', 'sync', '--json'))).toEqual({ animate: 'unchanged' });
    t6.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: s6v2, sources: ['emil/skills'] }];
    expect(statuses(await t6.cli('skills', 'sync', '--json'))).toEqual({ animate: 'updated' });
    expect(existsSync(t6.path('empty-library/animate'))).toBe(false);

    // Install via profiles/b -> shared-library, delete profiles/b, switch to profiles/c, and update to v1:
    // the orphaned copy in shared-library is cleaned up so nothing is left behind on disk.
    const t7 = setup();
    const s7v1 = await t7.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const s7v2 = await t7.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    t7.write('shared-library/.keep', '');
    t7.write('profiles/b/settings.json', '{}');
    t7.write('profiles/c/settings.json', '{}');
    symlinkSync(t7.path('shared-library'), t7.path('profiles/b/skills'));
    t7.registered([{ path: '~/profiles/b/CLAUDE.md', agent: 'claude' }]);
    t7.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s7v1, sources: ['emil/skills'] }];
    expect((await t7.cli('skills', 'sync', '--json')).code).toBe(0);
    rmSync(t7.path('profiles/b'), { recursive: true, force: true });
    t7.registered([{ path: '~/profiles/c/CLAUDE.md', agent: 'claude' }]);
    t7.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: s7v2, sources: ['emil/skills'] }];
    expect(statuses(await t7.cli('skills', 'sync', '--json'))).toEqual({ animate: 'updated' });
    expect(readFileSync(t7.path('profiles/c/skills/animate/SKILL.md'), 'utf8')).toBe('animate v2');
    expect(existsSync(t7.path('shared-library/animate'))).toBe(false);

    // Built-in alias precedence during orphan cleanup (S35), undeletable orphan at same Pin stays incomplete (S34),
    // repointed alias with failed orphan cleanup keeps old canonical dir (S33), and moving an alias from a missing
    // copy to another owned copy keeps ownership on unchanged sync (S36).
    const t8 = setup();
    const s8v1 = await t8.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const s8v2 = await t8.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    t8.write('profiles/a/settings.json', '{}');
    t8.write('profiles/b/settings.json', '{}');
    t8.registered([
      { path: '~/profiles/a/CLAUDE.md', agent: 'claude' },
      { path: '~/profiles/b/CLAUDE.md', agent: 'claude' },
    ]);
    t8.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s8v1, sources: ['emil/skills'] }];
    expect((await t8.cli('skills', 'sync', '--json')).code).toBe(0);
    // S36: delete profiles/a's copy and point profiles/a/skills to profiles/b/skills; unchanged sync must keep ownership.
    rmSync(t8.path('profiles/a/skills'), { recursive: true, force: true });
    symlinkSync(t8.path('profiles/b/skills'), t8.path('profiles/a/skills'));
    t8.registered([{ path: '~/profiles/a/CLAUDE.md', agent: 'claude' }]);
    expect(statuses(await t8.cli('skills', 'sync', '--json'))).toEqual({ animate: 'unchanged' });
    expect(statuses(await t8.cli('skills', 'sync', '--json'))).toEqual({ animate: 'unchanged' });

    // S33 + S34 + S35: install via profiles/a -> shared-lib, repoint profiles/a -> new-lib, point built-in
    // ~/.claude/skills -> shared-lib (so 'claude' takes precedence over 'dir:' in scanPlaces), and make
    // shared-lib read-only at the same Pin: cleanup fails, keeps incomplete: true AND both dirs in placeDirs,
    // then succeeds and removes the orphan once writable.
    const t9 = setup();
    const s9v1 = await t9.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t9.write('shared-lib/.keep', '');
    t9.write('new-lib/.keep', '');
    t9.write('profiles/a/settings.json', '{}');
    t9.write('.claude/settings.json', '{}');
    symlinkSync(t9.path('shared-lib'), t9.path('profiles/a/skills'));
    t9.registered([{ path: '~/profiles/a/CLAUDE.md', agent: 'claude' }]);
    t9.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s9v1, sources: ['emil/skills'] }];
    expect((await t9.cli('skills', 'sync', '--json')).code).toBe(0);
    rmSync(t9.path('profiles/a/skills'), { recursive: true, force: true });
    symlinkSync(t9.path('new-lib'), t9.path('profiles/a/skills'));
    symlinkSync(t9.path('shared-lib'), t9.path('.claude/skills'));
    chmodSync(t9.path('shared-lib'), 0o555);
    try {
      const blockedOrphan = await t9.cli('skills', 'sync', '--json');
      expect(blockedOrphan.code).toBe(1);
      expect(statuses(blockedOrphan)).toEqual({ animate: 'failed' });
      expect(readState(t9).managed.animate.incomplete).toBe(true);
      expect(Object.values(readState(t9).managed.animate.placeDirs)).toContain(realpathSync(t9.path('shared-lib')));
      expect(Object.values(readState(t9).managed.animate.placeDirs)).toContain(realpathSync(t9.path('new-lib')));
    } finally {
      chmodSync(t9.path('shared-lib'), 0o755);
    }
    const cleanedOrphan = await t9.cli('skills', 'sync', '--json');
    expect(cleanedOrphan.code).toBe(0);
    expect(statuses(cleanedOrphan)).toEqual({ animate: 'updated' });
    expect(readState(t9).managed.animate.incomplete).toBeUndefined();
    expect(existsSync(t9.path('shared-lib/animate'))).toBe(false);
    expect(readFileSync(t9.path('new-lib/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // S38 + S41: Recursive orphan removal deletes SKILL.md before failing on a protected nested file;
    // restoring and editing SKILL.md must be treated as drifted (S41), while leaving SKILL.md absent
    // retries cleanup cleanly once permissions are restored (S38).
    const t10 = setup();
    const s10v1 = await t10.skills.publish('emil/skills', sha('1'), 'animate', {
      'SKILL.md': 'animate v1',
      'nested/locked.txt': 'keep',
    });
    t10.write('shared-lib/.keep', '');
    t10.write('new-lib/.keep', '');
    t10.write('profiles/a/settings.json', '{}');
    symlinkSync(t10.path('shared-lib'), t10.path('profiles/a/skills'));
    t10.registered([{ path: '~/profiles/a/CLAUDE.md', agent: 'claude' }]);
    t10.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s10v1, sources: ['emil/skills'] }];
    expect((await t10.cli('skills', 'sync', '--json')).code).toBe(0);
    rmSync(t10.path('profiles/a/skills'), { recursive: true, force: true });
    symlinkSync(t10.path('new-lib'), t10.path('profiles/a/skills'));
    chmodSync(t10.path('shared-lib/animate/nested'), 0o555);
    try {
      const partialRm = await t10.cli('skills', 'sync', '--json');
      expect(partialRm.code).toBe(1);
      expect(statuses(partialRm)).toEqual({ animate: 'failed' });
      expect(existsSync(t10.path('shared-lib/animate/SKILL.md'))).toBe(false);
      expect(readState(t10).managed.animate.incomplete).toBe(true);
    } finally {
      chmodSync(t10.path('shared-lib/animate/nested'), 0o755);
    }
    // S41: If user restores and edits SKILL.md in the orphan before retry, sync must report drifted and keep it.
    t10.write('shared-lib/animate/SKILL.md', 'my restored edit');
    const driftedOrphan = await t10.cli('skills', 'sync', '--json');
    expect(driftedOrphan.code).toBe(3);
    expect(statuses(driftedOrphan)).toEqual({ animate: 'drifted' });
    expect(readFileSync(t10.path('shared-lib/animate/SKILL.md'), 'utf8')).toBe('my restored edit');
    // Removing the user's restored SKILL.md lets cleanup finish on retry.
    rmSync(t10.path('shared-lib/animate/SKILL.md'));
    const retriedRm = await t10.cli('skills', 'sync', '--json');
    expect(retriedRm.code).toBe(0);
    expect(statuses(retriedRm)).toEqual({ animate: 'updated' });
    expect(existsSync(t10.path('shared-lib/animate'))).toBe(false);
    expect(readFileSync(t10.path('new-lib/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // S42 + S44 + S45: Unpinning when removal deletes SKILL.md before hitting a protected nested file
    // (even with a read-only lock file and directory) records retry state so the next sync finishes removal.
    const t10b = setup();
    const s10bv1 = await t10b.skills.publish('emil/skills', sha('1'), 'animate', {
      'SKILL.md': 'animate v1',
      'nested/locked.txt': 'keep',
    });
    t10b.write('shared-lib/.keep', '');
    t10b.write('profiles/a/settings.json', '{}');
    symlinkSync(t10b.path('shared-lib'), t10b.path('profiles/a/skills'));
    t10b.registered([{ path: '~/profiles/a/CLAUDE.md', agent: 'claude' }]);
    t10b.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s10bv1, sources: ['emil/skills'] }];
    expect((await t10b.cli('skills', 'sync', '--json')).code).toBe(0);
    rmSync(t10b.path('profiles/a'), { recursive: true, force: true });
    t10b.server.state.skills = [];
    chmodSync(t10b.path('shared-lib/animate/nested'), 0o555);
    chmodSync(t10b.path('.agents/.skill-lock.json'), 0o444);
    chmodSync(t10b.path('.agents'), 0o555);
    try {
      const partialUnpin = await t10b.cli('skills', 'sync', '--json');
      expect(partialUnpin.code).toBe(1);
      expect(statuses(partialUnpin)).toEqual({ animate: 'failed' });
      expect(readState(t10b).managed.animate.incomplete).toBe(true);
    } finally {
      chmodSync(t10b.path('.agents'), 0o755);
      chmodSync(t10b.path('.agents/.skill-lock.json'), 0o644);
      chmodSync(t10b.path('shared-lib/animate/nested'), 0o755);
    }
    const retriedUnpin = await t10b.cli('skills', 'sync', '--json');
    expect(retriedUnpin.code).toBe(0);
    expect(statuses(retriedUnpin)).toEqual({ animate: 'removed' });
    expect(existsSync(t10b.path('shared-lib/animate'))).toBe(false);
    expect(readState(t10b).managed.animate).toBeUndefined();

    // S46: A SKILL.md symlink pointing to an unreadable target must NOT be treated as missing/removable
    // without --overwrite during an orphan cleanup retry.
    const t10c = setup();
    const s10cv1 = await t10c.skills.publish('emil/skills', sha('1'), 'animate', {
      'SKILL.md': 'animate v1',
      'nested/locked.txt': 'keep',
    });
    t10c.write('shared-lib/.keep', '');
    t10c.write('secret-dir/SKILL.md', 'my secret edit');
    t10c.write('profiles/a/settings.json', '{}');
    symlinkSync(t10c.path('shared-lib'), t10c.path('profiles/a/skills'));
    t10c.registered([{ path: '~/profiles/a/CLAUDE.md', agent: 'claude' }]);
    t10c.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s10cv1, sources: ['emil/skills'] }];
    expect((await t10c.cli('skills', 'sync', '--json')).code).toBe(0);
    rmSync(t10c.path('profiles/a'), { recursive: true, force: true });
    t10c.server.state.skills = [];
    chmodSync(t10c.path('shared-lib/animate/nested'), 0o555);
    try {
      expect((await t10c.cli('skills', 'sync', '--json')).code).toBe(1);
    } finally {
      chmodSync(t10c.path('shared-lib/animate/nested'), 0o755);
    }
    symlinkSync(t10c.path('secret-dir/SKILL.md'), t10c.path('shared-lib/animate/SKILL.md'));
    chmodSync(t10c.path('secret-dir'), 0o000);
    try {
      const unreadableRetry = await t10c.cli('skills', 'sync', '--json');
      expect(unreadableRetry.code).toBe(3);
      expect(statuses(unreadableRetry)).toEqual({ animate: 'drifted' });
      expect(existsSync(t10c.path('shared-lib/animate'))).toBe(true);
    } finally {
      chmodSync(t10c.path('secret-dir'), 0o755);
    }
    // S48: A SKILL.md symlink whose target passes through a regular file (ENOTDIR from stat, present in lstat)
    // must also be treated as unreadable/drifted rather than absent.
    rmSync(t10c.path('shared-lib/animate/SKILL.md'));
    t10c.write('regular-file', 'not a dir');
    symlinkSync(t10c.path('regular-file/SKILL.md'), t10c.path('shared-lib/animate/SKILL.md'));
    const enotdirRetry = await t10c.cli('skills', 'sync', '--json');
    expect(enotdirRetry.code).toBe(3);
    expect(statuses(enotdirRetry)).toEqual({ animate: 'drifted' });
    expect(existsSync(t10c.path('shared-lib/animate'))).toBe(true);

    // S52: An inaccessible managed directory must NOT cause an incomplete record to be forgotten/dropped.
    rmSync(t10c.path('shared-lib/animate/SKILL.md'));
    chmodSync(t10c.path('shared-lib'), 0o000);
    try {
      const hidden = await t10c.cli('skills', 'sync', '--json');
      expect(hidden.code).toBe(3);
      expect(statuses(hidden)).toEqual({ animate: 'drifted' });
      expect(readState(t10c).managed.animate).toBeDefined();
    } finally {
      chmodSync(t10c.path('shared-lib'), 0o755);
    }
    const afterRestore = await t10c.cli('skills', 'sync', '--json');
    expect(afterRestore.code).toBe(0);
    expect(statuses(afterRestore)).toEqual({ animate: 'removed' });
    expect(existsSync(t10c.path('shared-lib/animate'))).toBe(false);

    // S53 + S56: An inaccessible, unregistered Antigravity directory must not fail a Codex-only fallback removal
    // (with .cursor present so `skills remove` leaves ~/.agents/skills for fallback verification).
    const t10d = setup();
    const s10dv1 = await t10d.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t10d.write('.cursor/.keep', '');
    t10d.registered([{ path: '~/.codex/AGENTS.md', agent: 'codex' }]);
    t10d.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s10dv1, sources: ['emil/skills'] }];
    expect((await t10d.cli('skills', 'sync', '--json')).code).toBe(0);
    t10d.write('.gemini/config/skills/.keep', '');
    chmodSync(t10d.path('.gemini/config/skills'), 0o000);
    t10d.server.state.skills = [];
    try {
      const codexRemoved = await t10d.cli('skills', 'sync', '--json');
      expect(codexRemoved.code).toBe(0);
      expect(statuses(codexRemoved)).toEqual({ animate: 'removed' });
      expect(readState(t10d).managed.animate).toBeUndefined();
    } finally {
      chmodSync(t10d.path('.gemini/config/skills'), 0o755);
    }

    // S54: A built-in alias (.agents/skills -> inaccessible .claude/skills) must not hide an owned directory
    // on an incomplete record lacking placeDirs; S55: repointing a recorded alias to an unrelated inaccessible
    // directory must not block removal of the copy in the persisted canonical directory.
    const t10e = setup();
    const s10ev1 = await t10e.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t10e.registered([{ path: '~/.claude/CLAUDE.md', agent: 'claude' }]);
    t10e.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s10ev1, sources: ['emil/skills'] }];
    expect((await t10e.cli('skills', 'sync', '--json')).code).toBe(0);
    symlinkSync(t10e.path('.claude/skills'), t10e.path('.agents/skills'));
    const incNoDirs = readState(t10e);
    delete incNoDirs.managed.animate.placeDirs;
    incNoDirs.managed.animate.incomplete = true;
    t10e.write('.config/agentsync/skills.json', JSON.stringify(incNoDirs));
    t10e.server.state.skills = [];
    chmodSync(t10e.path('.claude/skills'), 0o000);
    try {
      expect((await t10e.cli('skills', 'sync', '--json')).code).toBe(3);
      expect(readState(t10e).managed.animate).toBeDefined();
    } finally {
      chmodSync(t10e.path('.claude/skills'), 0o755);
    }
    // S57: Once permissions are restored, removal succeeds cleanly without blocking.
    const removedAfterAliasRestore = await t10e.cli('skills', 'sync', '--json');
    expect(removedAfterAliasRestore.code).toBe(0);
    expect(statuses(removedAfterAliasRestore)).toEqual({ animate: 'removed' });
    expect(readState(t10e).managed.animate).toBeUndefined();

    const t10f = setup();
    const s10fv1 = await t10f.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t10f.write('shared-lib/.keep', '');
    t10f.write('locked-unrelated/.keep', '');
    t10f.write('profiles/a/settings.json', '{}');
    symlinkSync(t10f.path('shared-lib'), t10f.path('profiles/a/skills'));
    t10f.registered([{ path: '~/profiles/a/CLAUDE.md', agent: 'claude' }]);
    t10f.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s10fv1, sources: ['emil/skills'] }];
    expect((await t10f.cli('skills', 'sync', '--json')).code).toBe(0);
    rmSync(t10f.path('profiles/a/skills'), { recursive: true, force: true });
    symlinkSync(t10f.path('locked-unrelated'), t10f.path('profiles/a/skills'));
    t10f.server.state.skills = [];
    chmodSync(t10f.path('locked-unrelated'), 0o000);
    try {
      const removedDespiteRepoint = await t10f.cli('skills', 'sync', '--json');
      expect(removedDespiteRepoint.code).toBe(0);
      expect(statuses(removedDespiteRepoint)).toEqual({ animate: 'removed' });
      expect(existsSync(t10f.path('shared-lib/animate'))).toBe(false);
    } finally {
      chmodSync(t10f.path('locked-unrelated'), 0o755);
    }

    // S40: A persisted dir:<path> that becomes a symlink to another owned directory must NOT overwrite
    // the live mapping on an unchanged sync.
    const t11 = setup();
    const s11v1 = await t11.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t11.write('lib1/.keep', '');
    t11.write('lib2/.keep', '');
    t11.write('profiles/a/settings.json', '{}');
    t11.write('profiles/b/settings.json', '{}');
    symlinkSync(t11.path('lib1'), t11.path('profiles/a/skills'));
    symlinkSync(t11.path('lib2'), t11.path('profiles/b/skills'));
    t11.registered([
      { path: '~/profiles/a/CLAUDE.md', agent: 'claude' },
      { path: '~/profiles/b/CLAUDE.md', agent: 'claude' },
    ]);
    t11.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: s11v1, sources: ['emil/skills'] }];
    expect((await t11.cli('skills', 'sync', '--json')).code).toBe(0);
    // Replace lib1 with a symlink to lib2, persist dir:~/lib1 as the place key, and run two unchanged syncs.
    rmSync(t11.path('lib1'), { recursive: true, force: true });
    symlinkSync(t11.path('lib2'), t11.path('lib1'));
    const st11 = readState(t11);
    st11.managed.animate.places = ['dir:~/lib1', 'claude:~/profiles/b'];
    st11.managed.animate.placeDirs = {
      'dir:~/lib1': t11.path('lib1'),
      'claude:~/profiles/b': realpathSync(t11.path('lib2')),
    };
    t11.write('.config/agentsync/skills.json', JSON.stringify(st11));
    t11.registered([{ path: '~/profiles/b/CLAUDE.md', agent: 'claude' }]);
    expect(statuses(await t11.cli('skills', 'sync', '--json'))).toEqual({ animate: 'unchanged' });
    expect(statuses(await t11.cli('skills', 'sync', '--json'))).toEqual({ animate: 'unchanged' });
  });

  it('tracks the canonical copy after a halfway failure on Claude Code + Antigravity and retries without blocking', async () => {
    const t = await machineWithSkills();
    t.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/.gemini/config/AGENTS.md', agent: 'antigravity' },
    ]);
    t.server.state.skills = [t.server.state.skills[0]!];
    t.skills.failHalfway.add('animate');

    const failed = await t.cli('skills', 'sync', '--json');
    expect(failed.code).toBe(1);
    expect(statuses(failed)).toEqual({ animate: 'failed' });
    expect(readState(t).managed.animate.places).toContain('agents');
    expect(readState(t).managed.animate.incomplete).toBe(true);

    const retried = await t.cli('skills', 'sync', '--json');
    expect(retried.code).toBe(0);
    expect(statuses(retried)).toEqual({ animate: 'updated' });
    expect(readFileSync(t.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
    expect(readFileSync(t.path('.gemini/config/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
  });

  it('scans registered custom Claude homes outside ~/.claude* in SessionStart hooks', async () => {
    const t = setup();
    const v1 = await t.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t.registered([{ path: '~/profiles/personal/CLAUDE.md', agent: 'claude' }]);
    t.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: v1, sources: ['emil/skills'] }];
    // Install via sync, then clear AgentSync's managed record so only the exact-Pin copy and lock remain.
    await t.cli('skills', 'sync');
    forgetRecords(t);
    t.server.putTemplate('one\n');
    await t.cli('sync');

    const hook = await t.cli('sync', '--hook', 'claude');
    expect(hook.code).toBe(0);
    expect(hook.stdout).toBe('');

    // Adding an unmanaged skill under the registered custom home outside ~/.claude* is reported to the server.
    t.write('profiles/personal/skills/custom-only/SKILL.md', 'handwritten');
    const hook2 = await t.cli('sync', '--hook', 'claude');
    expect(hook2.code).toBe(0);
    const lastReport = t.server.state.reports.at(-1);
    expect(lastReport?.scan.some((item) => item.name === 'custom-only')).toBe(true);
    // Running the hook again with no changes does not re-report.
    const countBefore = t.server.state.reports.length;
    expect((await t.cli('sync', '--hook', 'claude')).code).toBe(0);
    expect(t.server.state.reports).toHaveLength(countBefore);

    // If cached state.places is cleared so the early report omits custom-only, the rescan still sends
    // the full correction even though it matches the previous report hash.
    const stalePlaces = readState(t);
    delete stalePlaces.places;
    t.write('.config/agentsync/skills.json', JSON.stringify(stalePlaces));
    expect((await t.cli('sync', '--hook', 'claude')).code).toBe(0);
    expect(t.server.state.reports.at(-1)?.scan.some((item) => item.name === 'custom-only')).toBe(true);

    // Two custom Claude homes whose skills/ both symlink to ~/shared-library, leaving only the second registered:
    // the hook must agree with `skills status` (unchanged, not 1 update).
    const t2 = setup();
    const sv1 = await t2.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t2.write('shared-library/.keep', '');
    t2.write('profiles/a/settings.json', '{}');
    t2.write('profiles/b/settings.json', '{}');
    symlinkSync(t2.path('shared-library'), t2.path('profiles/a/skills'));
    symlinkSync(t2.path('shared-library'), t2.path('profiles/b/skills'));
    t2.registered([
      { path: '~/profiles/a/CLAUDE.md', agent: 'claude' },
      { path: '~/profiles/b/CLAUDE.md', agent: 'claude' },
    ]);
    t2.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: sv1, sources: ['emil/skills'] }];
    expect((await t2.cli('skills', 'sync')).code).toBe(0);
    t2.registered([{ path: '~/profiles/b/CLAUDE.md', agent: 'claude' }]);
    t2.server.putTemplate('one\n');
    await t2.cli('sync');
    const sharedHook = await t2.cli('sync', '--hook', 'claude');
    expect(sharedHook.code).toBe(0);
    expect(sharedHook.stdout).toBe('');

    // If /machines/sync fails while /skills/report is reachable, the hook still sends a due local scan.
    const t3 = await machineWithSkills();
    t3.write('.agents/skills/offline-check/SKILL.md', 'mine');
    t3.server.state.down.add('/machines/sync');
    const hookDown = await t3.cli('sync', '--hook', 'pi');
    expect(hookDown.code).toBe(0);
    expect(t3.server.state.reports).toHaveLength(1);
    expect(t3.server.state.reports[0]!.scan.some((item) => item.name === 'offline-check')).toBe(true);
  });

  it('allows --overwrite to repair a broken multi-Claude install even when another copy has an unreadable SKILL.md', async () => {
    const t = setup();
    const v1 = await t.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    t.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/.claude_personal/CLAUDE.md', agent: 'claude' },
    ]);
    t.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: v1, sources: ['emil/skills'] }];
    expect((await t.cli('skills', 'sync')).code).toBe(0);
    rmSync(t.path('.claude/skills/animate/SKILL.md'));
    chmodSync(t.path('.claude_personal/skills/animate/SKILL.md'), 0o000);
    try {
      const repaired = await t.cli('skills', 'sync', '--overwrite', '--json');
      expect(repaired.code).toBe(0);
      expect(statuses(repaired)).toEqual({ animate: 'updated' });
      expect(readFileSync(t.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
      expect(readFileSync(t.path('.claude_personal/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');
    } finally {
      try { chmodSync(t.path('.claude_personal/skills/animate/SKILL.md'), 0o644); } catch {}
    }
  });

  it('retries across multiple interrupted updates leaving copies at v3, v2 and v1, while still guarding hand edits', async () => {
    const t = setup();
    const v1 = await t.skills.publish('emil/skills', sha('1'), 'animate', { 'SKILL.md': 'animate v1' });
    const v2 = await t.skills.publish('emil/skills', sha('2'), 'animate', { 'SKILL.md': 'animate v2' });
    const v3 = await t.skills.publish('emil/skills', sha('3'), 'animate', { 'SKILL.md': 'animate v3' });
    t.registered([
      { path: '~/.claude/CLAUDE.md', agent: 'claude' },
      { path: '~/.claude_personal/CLAUDE.md', agent: 'claude' },
      { path: '~/.claude_work/CLAUDE.md', agent: 'claude' },
    ]);
    t.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('1'), installedHash: v1, sources: ['emil/skills'] }];
    expect((await t.cli('skills', 'sync')).code).toBe(0);

    // First partial update to v2: ~/.claude and ~/.claude_personal reach v2, ~/.claude_work stays at v1.
    t.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('2'), installedHash: v2, sources: ['emil/skills'] }];
    t.skills.failClaudeHome.add(t.path('.claude_work'));
    expect((await t.cli('skills', 'sync', '--json')).code).toBe(1);

    // Second partial update to v3: ~/.claude reaches v3, ~/.claude_personal stays at v2, ~/.claude_work stays at v1.
    t.server.state.skills = [{ name: 'animate', repo: 'emil/skills', commit: sha('3'), installedHash: v3, sources: ['emil/skills'] }];
    t.skills.failClaudeHome.add(t.path('.claude_personal'));
    t.skills.failClaudeHome.add(t.path('.claude_work'));
    const partial = await t.cli('skills', 'sync', '--json');
    expect(partial.code).toBe(1);
    expect(statuses(partial)).toEqual({ animate: 'failed' });
    expect(readFileSync(t.path('.claude/skills/animate/SKILL.md'), 'utf8')).toBe('animate v3');
    expect(readFileSync(t.path('.claude_personal/skills/animate/SKILL.md'), 'utf8')).toBe('animate v2');
    expect(readFileSync(t.path('.claude_work/skills/animate/SKILL.md'), 'utf8')).toBe('animate v1');

    // A hand edit to an unfinished copy is still detected as Drift rather than overwritten.
    t.write('.claude_personal/skills/animate/SKILL.md', 'my hand edit');
    const drifted = await t.cli('skills', 'sync', '--json');
    expect(drifted.code).toBe(3);
    expect(statuses(drifted)).toEqual({ animate: 'drifted' });

    // Restore untouched v2 copy: retry finishes updating all three homes to v3 without --overwrite.
    t.write('.claude_personal/skills/animate/SKILL.md', 'animate v2');
    const retried = await t.cli('skills', 'sync', '--json');
    expect(retried.code).toBe(0);
    expect(statuses(retried)).toEqual({ animate: 'updated' });
    for (const dir of ['.claude', '.claude_personal', '.claude_work']) {
      expect(readFileSync(t.path(`${dir}/skills/animate/SKILL.md`), 'utf8')).toBe('animate v3');
    }
    expect(readState(t).managed.animate.incomplete).toBeUndefined();
    expect(readState(t).managed.animate.previousHashes).toBeUndefined();
  });
});
