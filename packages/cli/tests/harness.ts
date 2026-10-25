import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Target } from '@agentsync/contract';
import { run } from '../src/cli.js';
import type { Io } from '../src/io.js';
import { fakeServer } from './fake-server.js';

/** A temporary home directory and a fake server, with `cli()` to run commands against them. */
export function setup() {
  const home = mkdtempSync(join(tmpdir(), 'agentsync-test-'));
  const server = fakeServer();
  const answers: string[] = [];
  const edits: ((file: string) => void)[] = [];
  const launched: { agent: string; prompt: string }[] = [];
  const sleeps: number[] = [];
  const questions: string[] = [];
  let interactive = false;

  async function cli(...args: string[]) {
    let stdout = '';
    let stderr = '';
    const io: Io = {
      home,
      env: { EDITOR: 'fake-editor' },
      hostname: 'laptop',
      platform: 'linux',
      fetch: server.fetch,
      interactive,
      out: (text) => (stdout += `${text}\n`),
      err: (text) => (stderr += `${text}\n`),
      ask: async (question) => {
        questions.push(question);
        const answer = answers.shift();
        if (answer === undefined) throw new Error(`Unexpected question: ${question}`);
        return answer;
      },
      edit: async (file) => {
        const edit = edits.shift();
        if (!edit) throw new Error(`Unexpected edit of ${file}`);
        edit(file);
      },
      launchAgent: async (agent, prompt) => void launched.push({ agent, prompt }),
      sleep: async (ms) => void sleeps.push(ms),
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
