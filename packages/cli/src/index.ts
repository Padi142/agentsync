#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { run } from './cli.js';
import type { Io } from './io.js';
import { terminal } from './terminal.js';

const quote = (value: string) =>
  process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * How hooks should start this CLI: plain `agentsync` when it is installed on PATH, else this
 * exact Node and script. `npx` puts a temporary directory on PATH, which does not count.
 */
function selfCommand(): string {
  const name = process.platform === 'win32' ? 'agentsync.cmd' : 'agentsync';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || dir.includes('_npx')) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return 'agentsync';
    } catch {}
  }
  return `${quote(process.execPath)} ${quote(realpathSync(process.argv[1]!))}`;
}

function wait(command: string, args: string[], shell: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command.split(' ')[0]} exited with code ${code}.`)),
    );
  });
}

/** The `skills` CLI this package depends on, at its exact version. Never `npx skills`, which fetches the newest. */
const skillsBin = () => join(dirname(createRequire(import.meta.url).resolve('skills/package.json')), 'bin', 'cli.mjs');
/** A `skills add` clones a repository; give up on one that hangs. */
const SKILLS_TIMEOUT_MS = 5 * 60_000;

/**
 * Run `skills` with this Node. Telemetry is off (which also stops its own audit fetch: the server
 * fetches audits), git never prompts, and `core.autocrlf` is off for its clone so the checked-out bytes
 * match GitHub's and a Pin doesn't read as Drift. The rest of the person's git config (proxies) stays.
 */
function runSkills(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const count = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [skillsBin(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SKILLS_TIMEOUT_MS,
      env: {
        ...process.env,
        DISABLE_TELEMETRY: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: String(count + 1),
        [`GIT_CONFIG_KEY_${count}`]: 'core.autocrlf',
        [`GIT_CONFIG_VALUE_${count}`]: 'false',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const io: Io = {
  home: homedir(),
  env: process.env,
  hostname: hostname().replace(/\.local$/, ''),
  platform: process.platform,
  fetch: globalThis.fetch,
  tty: { stdin: !!process.stdin.isTTY, stdout: !!process.stdout.isTTY, stderr: !!process.stderr.isTTY },
  columns: process.stdout.columns,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  ...terminal,
  // $EDITOR may carry arguments, such as `code --wait`, so it runs through the shell.
  edit: (file) => wait(`${process.env.VISUAL || process.env.EDITOR || 'vi'} ${quote(file)}`, [], true),
  launchAgent: (agent, prompt) => wait(agent, [prompt], false),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runSkills,
  get self() {
    return selfCommand();
  },
};

process.exitCode = await run(process.argv.slice(2), io);
