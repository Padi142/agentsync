import { parseArgs } from 'node:util';
import { Context, type Flags, type Outcome } from './context.js';
import { CliError, describeError, EXIT, exitCodeFor, usage } from './exit.js';
import type { Io } from './io.js';
import { init } from './commands/init.js';
import { conflict } from './commands/conflict.js';
import { edit } from './commands/edit.js';
import { sync } from './commands/sync.js';
import { logout } from './commands/logout.js';
import { status } from './commands/status.js';
import { template } from './commands/template.js';
import { vars } from './commands/vars.js';

const VERSION = '0.1.0';

const HELP = `agentsync keeps your agents' Global Instructions in sync across your Machines.

Usage:
  agentsync init [--server <url>] [--name <name>] [--agent <id>]... [--target <agent>=<path>]...
                 [--var KEY=VALUE]... [--import <path>] [--no-hooks] [--no-skill] [--no-wait]
                       Register this Machine (alias: login), then set up its Targets and hooks
  agentsync sync [--overwrite | --keep] [--hook <agent>]
                       Render the Template into every Target on this Machine
  agentsync status     Show this Machine, its Targets, and open Conflicts
  agentsync edit [--file <path> --base <revision>]
                       Edit the Template in $EDITOR, or save a file as the next revision
  agentsync template [--out <path>]
                       Print the Template
  agentsync vars [--var KEY=VALUE]... [--unset KEY]...
                       Show or change this Machine's Variables
  agentsync conflict list
  agentsync conflict get <id> [--out <path>]
  agentsync conflict resolve <id> <file> [--base <revision>]
  agentsync logout     Revoke this Machine and remove its hooks

Global flags:
  --json        Print one JSON document on stdout
  --yes, -y     Never prompt; use flags and defaults
  --server      The AgentSync server URL (default: the one this Machine registered with)

Exit codes: 0 ok, 1 error, 2 usage, 3 Drift, 4 Conflict, 5 auth.`;

type Command = (ctx: Context) => Promise<Outcome>;

const COMMANDS: Record<string, Command> = {
  init,
  login: init,
  sync,
  edit,
  template,
  conflict,
  vars,
  status,
  logout,
};

function parse(argv: string[]): { flags: Flags; positionals: string[]; help: boolean; version: boolean } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      json: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      server: { type: 'string' },
      name: { type: 'string' },
      agent: { type: 'string', multiple: true, default: [] },
      target: { type: 'string', multiple: true, default: [] },
      var: { type: 'string', multiple: true, default: [] },
      unset: { type: 'string', multiple: true, default: [] },
      import: { type: 'string' },
      overwrite: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      hook: { type: 'string' },
      hooks: { type: 'boolean', default: true },
      skill: { type: 'boolean', default: true },
      wait: { type: 'boolean', default: true },
      file: { type: 'string' },
      base: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const { help, version, ...flags } = values;
  return { flags, positionals, help, version };
}

/** Run one CLI invocation and return its exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`agentsync: ${describeError(error)}\nRun agentsync --help for usage.`);
    return EXIT.usage;
  }
  const { flags, positionals, help, version } = parsed;
  const [name, ...args] = positionals;
  if (version) {
    io.out(VERSION);
    return EXIT.ok;
  }
  if (help || name === undefined || name === 'help') {
    io.out(HELP);
    return name === undefined && !help ? EXIT.usage : EXIT.ok;
  }

  try {
    const command = COMMANDS[name];
    if (!command) throw usage(`Unknown command "${name}". Run agentsync --help for usage.`);
    if (flags.overwrite && flags.keep) throw usage('Pass either --overwrite or --keep, not both.');
    const ctx = new Context(io, flags, args);
    const { code = EXIT.ok, data = {} } = await command(ctx);
    if (flags.json) io.out(JSON.stringify({ ok: code === EXIT.ok, ...data }, null, 2));
    return code;
  } catch (error) {
    const code = exitCodeFor(error);
    const message = describeError(error);
    if (flags.hook !== undefined) {
      // Hooks fail open: an agent session must start whatever happens here.
      io.out(`AgentSync: ${message}`);
      return EXIT.ok;
    }
    if (flags.json) {
      const details = error instanceof CliError ? error.details : {};
      io.out(JSON.stringify({ ok: false, error: { message, exitCode: code, ...details } }, null, 2));
    } else {
      io.err(`agentsync: ${message}`);
    }
    return code;
  }
}
