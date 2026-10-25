#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { delimiter, join } from 'node:path';
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
  get self() {
    return selfCommand();
  },
};

process.exitCode = await run(process.argv.slice(2), io);
