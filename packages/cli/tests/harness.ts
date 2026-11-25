import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Target } from '@agentsync/contract';
import { run } from '../src/cli.js';
import type { Io } from '../src/io.js';
import { folderHash } from '../src/skills/hash.js';
import { fakeServer } from './fake-server.js';

type SkillFiles = Record<string, string>;

/**
 * A fake of the `skills` CLI with the behaviour of 1.9.0: `add` silently replaces whatever is there,
 * puts the canonical copy in ~/.agents/skills with symlinks for Claude Code (at $CLAUDE_CONFIG_DIR or
 * ~/.claude) and Antigravity (~/.gemini/config/skills), or a plain copy when Claude Code is the only
 * agent, and records the lock; `remove` deletes every copy for the asked agents and always exits 0.
 */
function fakeSkills(home: string) {
  const published = new Map<string, Map<string, SkillFiles>>();
  const calls: string[][] = [];
  const invocations: { args: string[]; env?: Record<string, string> }[] = [];
  /** Names whose next `add` writes the canonical copy, then fails before Claude Code's link. */
  const failHalfway = new Set<string>();
  /** Claude config dirs whose next `add` fails without touching disk. */
  const failClaudeHome = new Set<string>();
  const lockFile = join(home, '.agents', '.skill-lock.json');
  const lock = () => {
    try {
      return JSON.parse(readFileSync(lockFile, 'utf8')) as { version: 3; skills: Record<string, unknown> };
    } catch {
      return { version: 3 as const, skills: {} as Record<string, unknown> };
    }
  };
  const saveLock = (value: ReturnType<typeof lock>) => {
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, JSON.stringify(value));
  };
  const writeFolder = (dir: string, files: SkillFiles) => {
    rmSync(dir, { recursive: true, force: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  const linkTo = (linkPath: string, target: string) => {
    rmSync(linkPath, { recursive: true, force: true });
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(relative(dirname(linkPath), target), linkPath);
  };

  async function run(args: string[], env?: Record<string, string>) {
    calls.push(args);
    invocations.push({ args, ...(env ? { env } : {}) });
    const [command, ...rest] = args;
    const agentsAt = rest.indexOf('-a');
    const agents = agentsAt < 0 ? [] : rest.slice(agentsAt + 1).filter((arg) => !arg.startsWith('-'));
    const claudeHome = env?.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
    if (command === 'remove') {
      const names = rest.slice(0, rest.findIndex((arg) => arg.startsWith('-')));
      const current = lock();
      // Like `skills`, keep the shared ~/.agents/skills copy (and its lock entry) while another agent it
      // knows, but wasn't asked about, reads that directory: here, Cursor.
      const shared = existsSync(join(home, '.cursor'));
      const hasSharedAgent = agents.some((agent) => agent !== 'claude-code' && agent !== 'antigravity');
      for (const name of names) {
        if (!shared && hasSharedAgent) rmSync(join(home, '.agents', 'skills', name), { recursive: true, force: true });
        if (agents.includes('claude-code')) rmSync(join(claudeHome, 'skills', name), { recursive: true, force: true });
        if (agents.includes('antigravity')) rmSync(join(home, '.gemini', 'config', 'skills', name), { recursive: true, force: true });
        if (!shared && hasSharedAgent) delete current.skills[name];
      }
      saveLock(current);
      return { code: 0, stdout: '', stderr: '' };
    }
    const [source] = rest;
    const [repo, commit] = source!.split('#');
    const names = rest.slice(rest.indexOf('--skill') + 1, rest.indexOf('-g'));
    const current = lock();
    const results = names.map((name) => {
      const files = published.get(`${repo}#${commit}`)?.get(name);
      if (!files) return { name, status: 'skipped', reason: 'No matching skill found in source' };
      if (agents.includes('claude-code') && failClaudeHome.delete(claudeHome)) {
        return { name, status: 'failed', error: `EACCES: ${claudeHome}` };
      }
      const canonical = join(home, '.agents', 'skills', name);
      const claude = join(claudeHome, 'skills', name);
      const antigravity = join(home, '.gemini', 'config', 'skills', name);
      // In skills 1.9.0, symlink mode is chosen only when agents have >1 distinct project `skillsDir`,
      // i.e. claude-code (`.claude/skills`) paired with any `.agents/skills` agent (codex/pi/opencode/antigravity).
      // Other combinations (including antigravity alone or codex+antigravity) use independent copies.
      const usesSymlink = agents.includes('claude-code') && agents.some((agent) => agent !== 'claude-code');
      const hasUniversal = agents.some((agent) => agent !== 'claude-code' && agent !== 'antigravity');
      if (usesSymlink) {
        writeFolder(canonical, files);
        if (failHalfway.delete(name)) return { name, status: 'failed', error: 'EACCES: Claude Code link' };
        linkTo(claude, canonical);
        if (agents.includes('antigravity')) linkTo(antigravity, canonical);
      } else {
        if (hasUniversal) writeFolder(canonical, files);
        if (agents.includes('claude-code')) writeFolder(claude, files);
        if (agents.includes('antigravity')) writeFolder(antigravity, files);
      }
      current.skills[name] = { source: repo, sourceType: 'github', ref: commit, skillFolderHash: 'x'.repeat(40) };
      return { name, status: 'installed', source: repo, ref: commit };
    });
    saveLock(current);
    return { code: results.every((result) => result.status === 'installed') ? 0 : 1, stdout: JSON.stringify(results), stderr: '' };
  }

  /** Rewrite the lock's source for `name`, as if someone had reinstalled it from another repository. */
  function lockSource(name: string, source: string) {
    const current = lock();
    current.skills[name] = { ...(current.skills[name] as object), source };
    saveLock(current);
  }

  return {
    calls,
    invocations,
    run,
    failHalfway,
    failClaudeHome,
    lockSource,
    /** Make `name` installable from `repo` at `commit`, and return its installed hash (the Pin's). */
    async publish(repo: string, commit: string, name: string, files: SkillFiles) {
      const key = `${repo}#${commit}`;
      published.set(key, (published.get(key) ?? new Map()).set(name, files));
      const dir = mkdtempSync(join(tmpdir(), 'agentsync-pin-'));
      writeFolder(dir, files);
      return (await folderHash(dir))!;
    },
  };
}

/**
 * A temporary home directory and a fake server, with `cli()` to run commands against them.
 * `env` adds environment variables for the commands.
 */
export function setup(options: { env?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agentsync-test-'));
  const server = fakeServer();
  const skills = fakeSkills(home);
  /** Answers in order: a choice's value, several values separated by commas, or text. */
  const answers: string[] = [];
  const edits: ((file: string) => void)[] = [];
  const launched: { agent: string; args: string[] }[] = [];
  const sleeps: number[] = [];
  const questions: string[] = [];
  let interactive = false;

  function next(question: string): string {
    questions.push(question);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`Unexpected question: ${question}`);
    return answer;
  }

  async function cli(...args: string[]) {
    let stdout = '';
    let stderr = '';
    const io: Io = {
      home,
      env: { EDITOR: 'fake-editor', ...options.env },
      hostname: 'laptop',
      platform: 'linux',
      fetch: server.fetch,
      tty: { stdin: interactive, stdout: interactive, stderr: interactive },
      out: (text) => (stdout += `${text}\n`),
      err: (text) => (stderr += `${text}\n`),
      select: async (message, choices) => {
        const answer = next(`${message} ${choices.map((choice) => choice.label).join(' / ')}`);
        if (!choices.some((choice) => choice.value === answer)) throw new Error(`"${answer}" is not a choice for: ${message}`);
        return answer as never;
      },
      multiselect: async (message, choices) => {
        const answer = next(`${message} ${choices.map((choice) => choice.label).join(' / ')}`);
        return answer.split(',').filter(Boolean) as never;
      },
      text: async (message, _style, options) => {
        const answer = next(message) || options?.initial || '';
        const problem = options?.validate?.(answer);
        if (problem) throw new Error(`Rejected "${answer}" for ${message}: ${problem}`);
        return answer;
      },
      progress: () => ({ stop() {} }),
      edit: async (file) => {
        const edit = edits.shift();
        if (!edit) throw new Error(`Unexpected edit of ${file}`);
        edit(file);
      },
      launchAgent: async (agent, args) => void launched.push({ agent, args }),
      sleep: async (ms) => void sleeps.push(ms),
      runSkills: (args, env) => skills.run(args, env),
      self: 'agentsync',
    };
    const code = await run(args, io);
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  }

  const path = (...parts: string[]) => join(home, ...parts);

  /** Register a Machine on the fake server and save its config, as if `init` had run. */
  function registered(targets: Target[] = [{ path: '~/.claude/CLAUDE.md', agent: 'claude' }], written = {}) {
    const { machine, token } = server.register('laptop', targets);
    const config = path('.config/agentsync/config.json');
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ server: server.url, token, machineId: machine.id, written }));
    return machine;
  }

  /** Write a file under the temporary home. */
  function write(relativePath: string, text: string) {
    mkdirSync(dirname(path(relativePath)), { recursive: true });
    writeFileSync(path(relativePath), text);
  }

  return {
    home,
    server,
    /** The fake `skills` CLI: what it was asked to do, and `publish` to make a Skill installable. */
    skills,
    cli,
    path,
    registered,
    write,
    /** Answer the next prompts, in order, as a person at a terminal would. */
    answer: (...next: string[]) => {
      interactive = true;
      answers.push(...next);
    },
    /** Queue what the "editor" does to the file it is given. */
    onEdit: (edit: (file: string) => void) => {
      interactive = true;
      edits.push(edit);
    },
    launched,
    sleeps,
    questions,
  };
}
