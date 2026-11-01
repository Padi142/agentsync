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
    const desired = { name: 'animate', repo: 'emil/skills', commit: skill.pin.commit, installedHash: skill.pin.installedHash };
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
    await skillsService(env).checkStale(10, new Date(Date.now() + 25 * 3600_000));
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
    await skillsService(env).checkStale(10, tomorrow());
    const [shown] = (await browser().skills.overview()).skills;
    expect(shown).toMatchObject({ pin: { commit: skill.pin.commit }, update: { pin: { commit: newer }, audited: true } });
  });

  it('moves the Pin to an audited version rated below High, and records it', async () => {
    const { skill, newer } = await withUpdate('medium');
    await browser().skills.settings({ autoUpdate: true });
    await skillsService(env).checkStale(10, tomorrow());
    const [shown] = (await browser().skills.overview()).skills;
    expect(shown).toMatchObject({ pin: { commit: newer }, update: null });
    expect((await browser().skills.history({ skillId: skill.id }))[0]).toMatchObject({
      kind: 'automatic', from: skill.pin.commit, to: newer, audits: { gen: { risk: 'medium' } },
    });
  });

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
      await skillsService(env).checkStale(10, tomorrow());
      const [shown] = (await browser().skills.overview()).skills;
      expect(shown).toMatchObject({ pin: { commit: skill.pin.commit }, update: { pin: { commit: newer } } });
    }
  });
});
