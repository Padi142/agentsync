import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { skillsService } from '../src/skills/service';
import { fakeGitHub, skillMd } from './fake-github';
import { createTestEnv, fakeWorkOSDevice, resetDb, rpcClient } from './helpers';

const identities = {
  alice: { id: 'user_alice', email: 'alice@example.com', firstName: 'Alice', lastName: null, emailVerified: true, profilePictureUrl: null },
  bob: { id: 'user_bob', email: 'bob@example.com', firstName: 'Bob', lastName: null, emailVerified: true, profilePictureUrl: null },
};
vi.mock('@workos-inc/node', async (importOriginal) => {
  const { WorkOS } = await importOriginal<typeof import('@workos-inc/node')>();
  return { WorkOS: class extends WorkOS {
    constructor(...args: ConstructorParameters<typeof WorkOS>) {
      super(...args);
      this.userManagement.loadSealedSession = (({ sessionData }: { sessionData: string }) => ({
        authenticate: async () => {
          const user = Object.values(identities).find((identity) => identity.id === sessionData);
          return user ? { authenticated: true, user, sessionId: `session_${user.id}` } : { authenticated: false, reason: 'invalid_session_cookie' };
        },
      })) as never;
    }
  } };
});

let mf: Miniflare;
let env: Env;
let workos: ReturnType<typeof fakeWorkOSDevice>;
let gh: ReturnType<typeof fakeGitHub>;

beforeAll(async () => {
  ({ mf, env } = await createTestEnv());
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await resetDb(env);
  // Restore in the reverse order the spies were stacked.
  gh?.restore();
  workos?.restore();
  workos = fakeWorkOSDevice();
  gh = fakeGitHub();
});

const browser = (who: keyof typeof identities = 'alice') => rpcClient(env, { cookie: `wos-session=${identities[who].id}` });

async function registerMachine(who: keyof typeof identities = 'alice', nickname = 'laptop') {
  const cli = rpcClient(env);
  const { deviceCode } = await cli.machines.deviceStart();
  workos.approve(deviceCode, identities[who]);
  const result = await cli.machines.devicePoll({ deviceCode, nickname, hostname: nickname, os: 'linux', targets: [{ path: '~/.claude/CLAUDE.md', agent: 'claude' }] });
  if (result.status !== 'approved') throw new Error(result.status);
  return { machine: result.machine, client: rpcClient(env, { token: result.token }) };
}

/** `env` with a count of its D1 statements, and of every outgoing request while `work` runs. */
async function counting<T>(work: (counted: Env) => Promise<T>) {
  const used = { queries: 0, requests: 0 };
  const DB = new Proxy(env.DB, { get(target, property) {
    if (property === 'prepare') used.queries++;
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const healthy = globalThis.fetch;
  globalThis.fetch = ((input, init) => { used.requests++; return healthy(input, init); }) as typeof fetch;
  try {
    return { result: await work({ ...env, DB }), used };
  } finally {
    globalThis.fetch = healthy;
  }
}

/** A repository whose `animate` skill lives in a folder of another name and ships a `metadata.json`. */
function skillRepo() {
  const first = gh.repo('emil/skills', {
    'README.md': 'hi',
    'skills/motion/SKILL.md': skillMd('animate'),
    'skills/motion/metadata.json': '{}',
    'skills/other/SKILL.md': skillMd('other'),
  });
  gh.commit('emil/skills', { 'README.md': 'unrelated change' });
  return first;
}

describe('Skills: who may change them', () => {
  it('lets only a signed-in browser add, assign, update, remove or change settings', async () => {
    skillRepo();
    const { client } = await registerMachine();
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    const denied = { code: 'UNAUTHORIZED' };
    await expect(client.skills.add({ repo: 'emil/skills', name: 'other' })).rejects.toMatchObject(denied);
    await expect(client.skills.assign({ skillId: skill.id, assignment: { to: 'all' } })).rejects.toMatchObject(denied);
    await expect(client.skills.update({ skillId: skill.id, commit: skill.pin.commit })).rejects.toMatchObject(denied);
    await expect(client.skills.updateAll()).rejects.toMatchObject(denied);
    await expect(client.skills.remove({ skillId: skill.id })).rejects.toMatchObject(denied);
    await expect(client.skills.settings({ autoUpdate: true })).rejects.toMatchObject(denied);
    await expect(client.skills.overview()).rejects.toMatchObject(denied);
    await expect(browser().skills.report({ scan: [] })).rejects.toMatchObject(denied);
  });

  it('keeps each account’s Skills to itself', async () => {
    skillRepo();
    const skill = await browser('alice').skills.add({ repo: 'emil/skills', name: 'animate' });
    await expect(browser('bob').skills.remove({ skillId: skill.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(browser('bob').skills.history({ skillId: skill.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await browser('bob').skills.overview()).skills).toEqual([]);
  });
});

describe('Adding a Skill', () => {
  it('pins the newest version of the folder whose frontmatter name matches, as skills installs it', async () => {
    const first = skillRepo();
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    expect(skill).toMatchObject({
      name: 'animate',
      repo: { fullName: 'emil/skills' },
      path: 'skills/motion',
      assignment: { to: 'all' },
      autoUpdate: true,
      update: null,
      // The folder last changed in the first commit, not at HEAD.
      pin: { commit: first, treeSha: gh.treeHash('emil/skills', first, 'skills/motion') },
    });
    // `skills` leaves metadata.json out on copy, so what it installs hashes differently from GitHub's tree.
    gh.commit('emil/skills', { 'skills/motion/metadata.json': null });
    expect(skill.pin.installedHash).toBe(gh.treeHash('emil/skills', 'HEAD', 'skills/motion'));
  });

  it('refuses private repositories, folders with symlinks, the reserved name and a name already taken', async () => {
    skillRepo();
    gh.repo('me/private', { 'SKILL.md': skillMd('secret') }, { private: true });
    gh.repo('me/linked', { 'skills/linked/SKILL.md': skillMd('linked'), 'skills/linked/x.md': { link: 'SKILL.md' } });
    gh.repo('me/agentsync', { 'SKILL.md': skillMd('agentsync') });
    await expect(browser().skills.add({ repo: 'me/private', name: 'secret' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(browser().skills.add({ repo: 'me/linked', name: 'linked' })).rejects.toMatchObject({ code: 'UNSUPPORTED_SKILL' });
    await expect(browser().skills.add({ repo: 'me/agentsync', name: 'agentsync' })).rejects.toMatchObject({ code: 'SKILL_NAME_TAKEN' });
    await expect(browser().skills.add({ repo: 'emil/skills', name: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // `skills` installs a skill under its frontmatter name as written, so only an exact match can be pinned.
    gh.repo('me/upper', { 'skills/upper/SKILL.md': skillMd('Upper') });
    await expect(browser().skills.add({ repo: 'me/upper', name: 'upper' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    await expect(browser().skills.add({ repo: 'emil/skills', name: 'animate' })).rejects.toMatchObject({ code: 'SKILL_NAME_TAKEN' });
  });

  it('rejects names and repositories that could be read as flags, before asking GitHub', async () => {
    await expect(browser().skills.add({ repo: '-x/repo', name: 'animate' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(browser().skills.add({ repo: 'emil/skills', name: '-animate' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(gh.calls).toEqual([]);
  });
});

describe('Found Skills', () => {
  it('reads audits under a repository’s current name, with empty verdicts for a skill skills.sh doesn’t know', async () => {
    skillRepo();
    gh.rename('emil/skills', 'emil/skills-renamed');
    gh.audit('emil/skills-renamed', 'animate', 'high');
    const verdicts = await browser().skills.audits({ repo: 'emil/skills', names: ['animate', 'unknown'] });
    expect(verdicts).toMatchObject([
      { name: 'animate', audits: { gen: { risk: 'high' } } },
      { name: 'unknown', audits: { gen: null, socket: null, snyk: null } },
    ]);
  });

  it('adds a Found Skill at the version the Machine has, by its renamed repository, with the newer one as an update', async () => {
    const first = skillRepo();
    const second = gh.commit('emil/skills', { 'skills/motion/SKILL.md': skillMd('animate', 'v2') });
    gh.rename('emil/skills', 'emil/skills-renamed');
    const { machine, client } = await registerMachine();
    // The Machine's lock still has the old name.
    await client.skills.report({ scan: [
      { name: 'animate', source: 'emil/skills', ref: null, hash: await gh.installedHash('emil/skills-renamed', first, 'skills/motion'), managed: false },
      { name: 'notes', source: null, ref: null, hash: null, managed: false },
    ] });

    const overview = await browser().skills.overview();
    expect(overview.found).toEqual([
      { kind: 'github', name: 'animate', source: 'emil/skills', machines: [{ machineId: machine.id, ref: null }] },
      { kind: 'local', name: 'notes', machineIds: [machine.id] },
    ]);
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate', machineId: machine.id });
    expect(skill.repo.fullName).toBe('emil/skills-renamed');
    expect(skill.pin.commit).toBe(first);
    expect(skill.update?.pin.commit).toBe(second);
    // Its copy is exactly the Pin, so it reads as installed: `skills sync` adopts it without reinstalling.
    expect(skill.machines).toEqual([{ machineId: machine.id, status: 'installed' }]);
    expect((await browser().skills.overview()).found).toEqual([{ kind: 'local', name: 'notes', machineIds: [machine.id] }]);
  });

  it('refuses a copy that matches no version on the default branch, such as one from another branch', async () => {
    skillRepo();
    const side = gh.commit('emil/skills', { 'skills/motion/SKILL.md': skillMd('animate', 'from a fork') }, 'fork');
    const { machine, client } = await registerMachine();
    await client.skills.report({ scan: [{ name: 'animate', source: 'emil/skills', ref: side, hash: await gh.installedHash('emil/skills', side, 'skills/motion'), managed: false }] });
    await expect(browser().skills.add({ repo: 'emil/skills', name: 'animate', machineId: machine.id }))
      .rejects.toMatchObject({ code: 'NO_MATCHING_COMMIT' });
  });

});

describe('Assignment and what Machines get', () => {
  it('sends a Skill to every Machine, or only the chosen ones of the same account', async () => {
    skillRepo();
    const laptop = await registerMachine('alice', 'laptop');
    const desktop = await registerMachine('alice', 'desktop');
    const bobs = await registerMachine('bob', 'bobs');
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    const desired = { name: 'animate', repo: 'emil/skills', commit: skill.pin.commit, installedHash: skill.pin.installedHash, sources: ['emil/skills'] };
    expect((await laptop.client.machines.sync()).skills).toEqual([desired]);
    expect((await desktop.client.machines.sync()).skills).toEqual([desired]);

    const chosen = await browser().skills.assign({
      skillId: skill.id, assignment: { to: 'chosen', machineIds: [desktop.machine.id, bobs.machine.id] },
    });
    // Bob's Machine is not Alice's to choose.
    expect(chosen.assignment).toEqual({ to: 'chosen', machineIds: [desktop.machine.id] });
    expect((await laptop.client.machines.sync()).skills).toEqual([]);
    expect((await desktop.client.machines.sync()).skills).toEqual([desired]);
    expect((await bobs.client.machines.sync()).skills).toEqual([]);
  });

  it('moves the Pin to a newer version a Machine has, so every Machine gets it', async () => {
    skillRepo();
    const { machine, client } = await registerMachine();
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    const newer = gh.commit('emil/skills', { 'skills/motion/SKILL.md': skillMd('animate', 'v2') });
    await skillsService(env).checkStale(40, new Date(Date.now() + 25 * 3600_000));
    await client.skills.report({ scan: [
      { name: 'animate', source: 'emil/skills', ref: newer, hash: await gh.installedHash('emil/skills', newer, 'skills/motion'), managed: true },
    ] });

    const [shown] = (await browser().skills.overview()).skills;
    expect(shown!.machines).toEqual([{ machineId: machine.id, status: 'newer', commit: newer, committedAt: expect.any(Date) }]);
    const moved = await browser().skills.update({ skillId: skill.id, commit: newer });
    expect(moved).toMatchObject({ pin: { commit: newer }, update: null, machines: [{ status: 'installed' }] });
    expect((await browser().skills.history({ skillId: skill.id })).map((move) => [move.kind, move.from, move.to]))
      .toEqual([['manual', skill.pin.commit, newer], ['added', null, skill.pin.commit]]);
  });

  it('refuses to pin a commit that is not a version of the folder on the default branch', async () => {
    skillRepo();
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    const side = gh.commit('emil/skills', { 'skills/motion/SKILL.md': skillMd('animate', 'side') }, 'fork');
    await expect(browser().skills.update({ skillId: skill.id, commit: side })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('The update check', () => {
  const tomorrow = () => new Date(Date.now() + 25 * 3600_000);

  async function withUpdate(risk: Parameters<typeof gh.audit>[2] | null) {
    skillRepo();
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    const newer = gh.commit('emil/skills', { 'skills/motion/SKILL.md': skillMd('animate', 'v2') });
    if (risk) gh.audit('emil/skills', 'animate', risk);
    return { skill, newer };
  }

  it('only offers the update while automatic updates are off', async () => {
    const { skill, newer } = await withUpdate('safe');
    await skillsService(env).checkStale(40, tomorrow());
    const [shown] = (await browser().skills.overview()).skills;
    expect(shown).toMatchObject({ pin: { commit: skill.pin.commit }, update: { pin: { commit: newer }, audited: true } });
  });

  it('moves the Pin to an audited version rated below High, and records it', async () => {
    const { skill, newer } = await withUpdate('medium');
    await browser().skills.settings({ autoUpdate: true });
    await skillsService(env).checkStale(40, tomorrow());
    const [shown] = (await browser().skills.overview()).skills;
    expect(shown).toMatchObject({ pin: { commit: newer }, update: null });
    expect((await browser().skills.history({ skillId: skill.id }))[0]).toMatchObject({
      kind: 'automatic', from: skill.pin.commit, to: newer, audits: { gen: { risk: 'medium' } },
    });
  });

  it('finishes every version read of a failed check before moving on, so the budget sees their work', async () => {
    const { skill } = await withUpdate(null);
    gh.commit('emil/skills', { 'skills/motion/SKILL.md': skillMd('animate', 'v3') });
    const healthy = globalThis.fetch;
    let trees = 0;
    let running = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes(':skills%2Fmotion') && !url.includes(':skills/motion')) return healthy(input, init);
      if (trees++ === 0) return new Response('down', { status: 500 });
      running++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      running--;
      return healthy(input, init);
    }) as typeof fetch;
    try {
      await skillsService(env).checkStale(40, tomorrow());
    } finally {
      globalThis.fetch = healthy;
    }
    expect(trees).toBe(2);
    expect(running).toBe(0);
    expect((await browser().skills.overview()).skills[0]!.pin.commit).toBe(skill.pin.commit);
  });

  it('counts audit lookups against the request budget', async () => {
    const names = Array.from({ length: 14 }, (_, i) => `skill-${String(i).padStart(2, '0')}`);
    gh.repo('team/many', Object.fromEntries(names.map((name) => [`skills/${name}/SKILL.md`, skillMd(name)])));
    await browser().skills.collection({ repo: 'team/many' });
    for (const name of names) await browser().skills.add({ repo: 'team/many', name });
    // The last Skill has five versions nothing has read yet, so its check is the most expensive one.
    for (let version = 2; version <= 6; version++) gh.commit('team/many', { 'skills/skill-13/SKILL.md': skillMd('skill-13', `v${version}`) });
    const { used } = await counting((counted) => skillsService(counted).checkStale(40, tomorrow()));
    expect(used.requests).toBeLessThanOrEqual(40);
  }, 30_000);

  it('holds back a version rated High, one not audited since its push, and Skills on the ignore list', async () => {
    await browser().skills.settings({ autoUpdate: true });
    for (const setup of [
      () => withUpdate('high'),
      async () => {
        const result = await withUpdate(null);
        gh.audit('emil/skills', 'animate', 'safe', new Date(gh.pushedAt('emil/skills').getTime() - 60_000));
        return result;
      },
      async () => {
        const result = await withUpdate('safe');
        await browser().skills.setAutoUpdate({ skillId: result.skill.id, autoUpdate: false });
        return result;
      },
    ]) {
      await resetDb(env);
      await browser().skills.settings({ autoUpdate: true });
      const { skill, newer } = await setup();
      await skillsService(env).checkStale(40, tomorrow());
      const [shown] = (await browser().skills.overview()).skills;
      expect(shown).toMatchObject({ pin: { commit: skill.pin.commit }, update: { pin: { commit: newer } } });
    }
  }, 15_000); // Three rounds of real git repositories, which can pass 5s on a busy machine.
});

describe('What a check may offer', () => {
  const tomorrow = () => new Date(Date.now() + 25 * 3600_000);

  it('never updates automatically to an older version when the newest one can’t be installed', async () => {
    skillRepo();
    await browser().skills.settings({ autoUpdate: true });
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    const usable = gh.commit('emil/skills', { 'skills/motion/SKILL.md': skillMd('animate', 'v2') });
    gh.commit('emil/skills', { 'skills/motion/link.md': { link: 'SKILL.md' } });
    // Fresh, safe verdicts describe the newest content, which has the symlink.
    gh.audit('emil/skills', 'animate', 'safe');
    await skillsService(env).checkStale(40, tomorrow());
    const [shown] = (await browser().skills.overview()).skills;
    expect(shown).toMatchObject({ pin: { commit: skill.pin.commit }, update: { pin: { commit: usable }, audited: false } });
  });

  it('offers no version that stopped being this skill', async () => {
    skillRepo();
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    gh.commit('emil/skills', { 'skills/motion/SKILL.md': skillMd('renamed') });
    gh.commit('emil/skills', { 'skills/motion/SKILL.md': null, 'skills/motion/README.md': 'no skill' });
    await skillsService(env).checkStale(40, tomorrow());
    const [shown] = (await browser().skills.overview()).skills;
    expect(shown).toMatchObject({ pin: { commit: skill.pin.commit }, update: null });
  });

  it('keeps checking a Skill whose folder moved away, and offers nothing past the move', async () => {
    skillRepo();
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    gh.commit('emil/skills', { 'skills/motion/SKILL.md': null, 'skills/motion/metadata.json': null, 'skills/core/motion/SKILL.md': skillMd('animate') });
    expect(await skillsService(env).checkStale(40, tomorrow())).toEqual({ checked: 1, stale: 1 });
    const [shown] = (await browser().skills.overview()).skills;
    expect(shown).toMatchObject({ pin: { commit: skill.pin.commit }, update: null });
  });

  it('remembers a repository’s old name after a rename, so Machines whose lock says it still adopt', async () => {
    skillRepo();
    const skill = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    gh.rename('emil/skills', 'emil/renamed');
    await skillsService(env).checkStale(40, tomorrow());
    const { client } = await registerMachine();
    expect((await client.machines.sync()).skills[0]).toMatchObject({ repo: 'emil/renamed', sources: ['emil/renamed', 'emil/skills'] });
    await client.skills.report({ scan: [{ name: 'animate', source: 'emil/skills', ref: null, hash: skill.pin.installedHash, managed: false }] });
    expect((await browser().skills.overview()).skills[0]!.machines[0]).toMatchObject({ status: 'installed' });
  });

  it('keeps the stored name when GitHub’s new one could be read as a flag', async () => {
    skillRepo();
    const { client } = await registerMachine();
    await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    gh.rename('emil/skills', 'emil/-skills');
    await skillsService(env).checkStale(40, tomorrow());
    expect((await browser().skills.overview()).skills[0]!.repo.fullName).toBe('emil/skills');
    expect((await client.machines.sync()).skills[0]!.repo).toBe('emil/skills');
  });
});

describe('Finding the folder', () => {
  it('pins the first folder `skills` walks to that declares the name, as `skills` keeps the first', async () => {
    gh.repo('two/names', { 'skills/a/SKILL.md': skillMd('demo', 'first'), 'skills/demo/SKILL.md': skillMd('demo', 'second') });
    expect((await browser().skills.add({ repo: 'two/names', name: 'demo' })).path).toBe('skills/a');
  });
});

describe('Adding several skills at once', () => {
  it('reads the repository once, keeps each Machine’s version, and says why a skill failed', async () => {
    const first = gh.repo('team/many', { 'skills/a/SKILL.md': skillMd('a'), 'skills/b/SKILL.md': skillMd('b'), 'skills/c/SKILL.md': skillMd('c') });
    const second = gh.commit('team/many', { 'skills/a/SKILL.md': skillMd('a', 'v2'), 'skills/b/SKILL.md': skillMd('b', 'v2') });
    const side = gh.commit('team/many', { 'skills/c/SKILL.md': skillMd('c', 'fork') }, 'fork');
    const { machine, client } = await registerMachine();
    await client.skills.report({ scan: [
      { name: 'a', source: 'team/many', ref: null, hash: await gh.installedHash('team/many', first, 'skills/a'), managed: false },
      { name: 'b', source: 'team/many', ref: null, hash: await gh.installedHash('team/many', second, 'skills/b'), managed: false },
      { name: 'c', source: 'team/many', ref: null, hash: await gh.installedHash('team/many', side, 'skills/c'), managed: false },
    ] });
    gh.calls.length = 0;
    const result = await browser().skills.addMany({ repo: 'team/many', skills: [
      { name: 'a', machineId: machine.id }, { name: 'gone', machineId: machine.id }, { name: 'b', machineId: machine.id }, { name: 'c', machineId: machine.id },
    ] });
    expect(result).toEqual({
      added: ['a', 'b'],
      failed: [{ name: 'gone', code: 'NOT_FOUND' }, { name: 'c', code: 'NO_MATCHING_COMMIT' }],
      rest: [],
    });
    expect(gh.calls.filter((call) => /\/git\/trees\/[0-9a-f]+\?/.test(call) && !call.includes(':'))).toHaveLength(1);
    const { skills } = await browser().skills.overview();
    const a = skills.find((skill) => skill.name === 'a')!;
    expect(a.pin.commit).toBe(first);
    expect(a.update?.pin.commit).toBe(second);
    expect(skills.find((skill) => skill.name === 'b')!.pin.commit).toBe(second);
  });

  it('finds a Machine’s copy however many versions ago it was', async () => {
    const first = gh.repo('team/old', { 'skills/a/SKILL.md': skillMd('a') });
    for (let version = 2; version <= 13; version++) gh.commit('team/old', { 'skills/a/SKILL.md': skillMd('a', `v${version}`) });
    const { machine, client } = await registerMachine();
    await client.skills.report({ scan: [{ name: 'a', source: 'team/old', ref: null, hash: await gh.installedHash('team/old', first, 'skills/a'), managed: false }] });
    expect(await browser().skills.addMany({ repo: 'team/old', skills: [{ name: 'a', machineId: machine.id }] })).toEqual({ added: ['a'], failed: [], rest: [] });
    expect((await browser().skills.overview()).skills[0]!.pin.commit).toBe(first);
  });

  it('stays within a Worker’s limits on every call, however many folders there are and however far back a Machine’s copy is', async () => {
    const first = gh.repo('team/old', {
      ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`skills/other-${String(i).padStart(2, '0')}/SKILL.md`, skillMd(`other-${i}`)])),
      'skills/zed/SKILL.md': skillMd('zed'),
    });
    for (let version = 2; version <= 60; version++) gh.commit('team/old', { 'skills/zed/SKILL.md': skillMd('zed', `v${version}`) });
    const { machine, client } = await registerMachine();
    await client.skills.report({ scan: [{ name: 'zed', source: 'team/old', ref: null, hash: await gh.installedHash('team/old', first, 'skills/zed'), managed: false }] });
    const add = async () => {
      const { result, used } = await counting((counted) => rpcClient(counted, { cookie: `wos-session=${identities.alice.id}` }).skills
        .addMany({ repo: 'team/old', skills: [{ name: 'zed', machineId: machine.id }] }));
      expect(used.queries).toBeLessThanOrEqual(50);
      expect(used.requests).toBeLessThanOrEqual(50);
      return result;
    };
    let result = await add();
    for (let calls = 1; result.rest.length; calls++) {
      expect(calls).toBeLessThan(10);
      result = await add();
    }
    expect(result).toEqual({ added: ['zed'], failed: [], rest: [] });
    expect((await browser().skills.overview()).skills[0]!.pin.commit).toBe(first);
  }, 30_000);

  it('keeps the update check within a Worker’s D1 limit, leaving the rest for the next run', async () => {
    const names = Array.from({ length: 24 }, (_, i) => `skill-${String(i).padStart(2, '0')}`);
    gh.repo('team/many', Object.fromEntries(names.map((name) => [`skills/${name}/SKILL.md`, skillMd(name)])));
    await browser().skills.settings({ autoUpdate: true });
    await browser().skills.collection({ repo: 'team/many' });
    for (let start = 0; start < names.length; start += 6) {
      await browser().skills.addMany({ repo: 'team/many', skills: names.slice(start, start + 6).map((name) => ({ name })) });
    }
    gh.commit('team/many', Object.fromEntries(names.map((name) => [`skills/${name}/SKILL.md`, skillMd(name, 'v2')])));
    for (const name of names) gh.audit('team/many', name, 'safe');
    const { result, used } = await counting((counted) => skillsService(counted).checkStale(1000, new Date(Date.now() + 25 * 3600_000)));
    expect(used.queries).toBeLessThanOrEqual(50);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.checked).toBeLessThan(names.length);
  }, 30_000);

  it.each([
    ['answers with an error', () => new Response('down', { status: 500 })],
    ['breaks off mid-answer', () => new Response(new ReadableStream({ pull: (controller) => controller.error(new TypeError('connection reset')) }))],
  ])('reports a saved skill as added when GitHub %s while looking for its newer versions', async (_, failure) => {
    const first = gh.repo('team/old', { 'skills/a/SKILL.md': skillMd('a') });
    const between = gh.commit('team/old', { 'skills/a/SKILL.md': skillMd('a', 'v2') });
    gh.commit('team/old', { 'skills/a/SKILL.md': skillMd('a', 'v3') });
    const { machine, client } = await registerMachine();
    await client.skills.report({ scan: [{ name: 'a', source: 'team/old', ref: null, hash: await gh.installedHash('team/old', first, 'skills/a'), managed: false }] });
    const healthy = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes('raw.githubusercontent.com') && url.includes(between) ? failure() : healthy(input, init);
    }) as typeof fetch;
    try {
      // The search for the Machine's copy passes `between` without needing its name; the check for newer versions does.
      expect(await browser().skills.addMany({ repo: 'team/old', skills: [{ name: 'a', machineId: machine.id }] })).toEqual({ added: ['a'], failed: [], rest: [] });
    } finally {
      globalThis.fetch = healthy;
    }
    expect((await browser().skills.overview()).skills[0]!.pin.commit).toBe(first);
  });

  it('finds a skill even if a folder it had no need to read can’t be read', async () => {
    gh.repo('team/flaky', { 'skills/a/SKILL.md': skillMd('a'), 'skills/b/SKILL.md': skillMd('b') });
    const healthy = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes('skills/b/SKILL.md') ? new Response('down', { status: 500 }) : healthy(input, init);
    }) as typeof fetch;
    try {
      expect((await browser().skills.add({ repo: 'team/flaky', name: 'a' })).name).toBe('a');
      await expect(browser().skills.add({ repo: 'team/flaky', name: 'b' })).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    } finally {
      globalThis.fetch = healthy;
    }
  });

  it('hands back what it has no budget for, and a second call carries on from what the first read', async () => {
    gh.repo('team/deep', Object.fromEntries(Array.from({ length: 45 }, (_, i) => {
      const name = `skill-${String(i).padStart(2, '0')}`;
      return [`skills/${name}/SKILL.md`, skillMd(name)];
    })));
    const input = { repo: 'team/deep', skills: [{ name: 'skill-44' }] };
    expect(await browser().skills.addMany(input)).toEqual({ added: [], failed: [], rest: ['skill-44'] });
    expect(await browser().skills.addMany(input)).toEqual({ added: ['skill-44'], failed: [], rest: [] });
  }, 15_000);

  it('rejects Machine tokens and unauthenticated clients', async () => {
    const { client } = await registerMachine();
    for (const caller of [client, rpcClient(env)]) {
      await expect(caller.skills.addMany({ repo: 'emil/skills', skills: [{ name: 'animate' }] })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });
});

describe('Skill collections', () => {
  it('browses every page at one commit and can add a skill beyond the direct lookup budget', async () => {
    gh.repo('team/collection', Object.fromEntries(Array.from({ length: 35 }, (_, i) => {
      const name = `skill-${String(i).padStart(2, '0')}`;
      return [`skills/${name}/SKILL.md`, skillMd(name)];
    })));
    const first = await browser().skills.collection({ repo: 'team/collection' });
    expect(first.names).toHaveLength(20);
    expect(first.next).toBe(20);
    gh.commit('team/collection', { 'skills/skill-34/SKILL.md': null });
    const second = await browser().skills.collection({ repo: 'team/collection', commit: first.commit, offset: first.next! });
    expect(second.names).toHaveLength(15);
    expect(second.names).toContain('skill-34');
    expect(second.next).toBeNull();
    // Browse HEAD again so the current tree's names are cached for the normal Add path.
    const current = await browser().skills.collection({ repo: 'team/collection' });
    await browser().skills.collection({ repo: 'team/collection', commit: current.commit, offset: current.next! });
    expect((await browser().skills.add({ repo: 'team/collection', name: 'skill-33' })).name).toBe('skill-33');
  }, 15_000); // The fixture reads 70 real git blobs while exercising both immutable repository snapshots.

  it('says a skill past the read budget isn’t found yet, not that it doesn’t exist, and finds it when asked again', async () => {
    gh.repo('team/deep', Object.fromEntries(Array.from({ length: 45 }, (_, i) => {
      const name = `skill-${String(i).padStart(2, '0')}`;
      return [`skills/${name}/SKILL.md`, skillMd(name)];
    })));
    await expect(browser().skills.add({ repo: 'team/deep', name: 'skill-44' })).rejects.toMatchObject({ code: 'UNSUPPORTED_SKILL' });
    expect((await browser().skills.add({ repo: 'team/deep', name: 'skill-44' })).name).toBe('skill-44');
  }, 15_000);

  it('does not offer private, unsafe or unsupported skills in a collection', async () => {
    gh.repo('team/collection', {
      'skills/good/SKILL.md': skillMd('good'),
      'skills/invalid/SKILL.md': skillMd('-bad-name'),
      'skills/linked/SKILL.md': skillMd('linked'),
      'skills/linked/x.md': { link: 'SKILL.md' },
    });
    expect((await browser().skills.collection({ repo: 'team/collection' })).names).toEqual(['good']);
    gh.repo('team/private', { 'SKILL.md': skillMd('private') }, { private: true });
    await expect(browser().skills.collection({ repo: 'team/private' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps exclusions across scans, scopes them by account and source, and restores them on explicit Add', async () => {
    skillRepo();
    const { client } = await registerMachine();
    await client.skills.report({ scan: [{ name: 'animate', source: 'emil/skills', ref: null, hash: 'a'.repeat(40), managed: false }] });
    await browser().skills.setIgnored({ repo: 'EMIL/skills', names: ['animate'], ignored: true });
    await client.skills.report({ scan: [] });
    expect((await browser().skills.overview()).ignored).toEqual([{ repo: 'emil/skills', name: 'animate' }]);
    expect((await browser('bob').skills.overview()).ignored).toEqual([]);
    await browser('bob').skills.setIgnored({ repo: 'emil/skills', names: ['other'], ignored: true });
    await browser().skills.setIgnored({ repo: 'other/skills', names: ['animate'], ignored: true });
    await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    expect((await browser().skills.overview()).ignored).toEqual([{ repo: 'other/skills', name: 'animate' }]);
    expect((await browser('bob').skills.overview()).ignored).toEqual([{ repo: 'emil/skills', name: 'other' }]);
  });

  it('preserves added skills, pins and assignments when a collection exclusion includes them', async () => {
    skillRepo();
    const { client } = await registerMachine();
    const animate = await browser().skills.add({ repo: 'emil/skills', name: 'animate' });
    await browser().skills.add({ repo: 'emil/skills', name: 'other' });
    await browser().skills.setIgnored({ repo: 'emil/skills', names: ['animate'], ignored: true });
    expect((await client.machines.sync()).skills.map((skill) => skill.name)).toEqual(['animate', 'other']);
    expect((await browser().skills.overview()).skills.find((skill) => skill.id === animate.id)).toEqual(animate);
    await browser().skills.setIgnored({ repo: 'emil/skills', names: ['animate'], ignored: false });
    expect((await browser().skills.overview()).ignored).toEqual([]);
    expect((await client.machines.sync()).skills.map((skill) => skill.name)).toEqual(['animate', 'other']);
  });

  it('rejects collection changes and browsing from Machine tokens and unauthenticated clients', async () => {
    const { client } = await registerMachine();
    for (const caller of [client, rpcClient(env)]) {
      await expect(caller.skills.collection({ repo: 'emil/skills' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(caller.skills.setIgnored({ repo: 'emil/skills', names: ['animate'], ignored: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });
});
