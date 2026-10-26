import { parseArgs } from 'node:util';
import { Context, type Flags, type Outcome } from './context.js';
import { CliError, describeError, EXIT, exitCodeFor, usage } from './exit.js';
import type { Io } from './io.js';
import { palette } from './style.js';
import { init } from './commands/init.js';
import { conflict } from './commands/conflict.js';
import { edit } from './commands/edit.js';
import { sync } from './commands/sync.js';
import { logout } from './commands/logout.js';
import { rename } from './commands/rename.js';
import { status } from './commands/status.js';
import { template } from './commands/template.js';
import { vars } from './commands/vars.js';

const VERSION = '0.1.0';

const HELP = `agentsync keeps your agents' Global Instructions in sync across your Machines.

Usage: agentsync <command> [flags]

Commands:
  init        Register this Machine (alias: login), set up its Targets and hooks
  sync        Render the Template into every Target on this Machine
  status      Show this Machine, its Targets, and open Conflicts
  edit        Edit the Template in $EDITOR, or save a file as the next revision
  template    Print the Template
  vars        Show or change this Machine's Variables
  conflict    List, get, or resolve open Conflicts
  rename      Change this Machine's nickname
  logout      Revoke this Machine and remove its hooks

Common flags:
  --json          Print one JSON document on stdout
  --yes, -y       Never prompt; use flags and defaults
  --verbose       Show per-file steps and full diffs
  --plain         No color, symbols, or animation; numbered prompts
  --no-color      No color (also: NO_COLOR=1)
  --no-progress   No spinner
  --server <url>  The AgentSync server (default: the one this Machine registered with)

Run agentsync help <command> for its flags and examples.
Exit codes: 0 ok, 1 error, 2 usage, 3 Drift, 4 Conflict, 5 auth, 130 cancelled.`;

const COMMAND_HELP: Record<string, string> = {
  init: `Usage: agentsync init [--server <url>] [--nickname <nickname>] [--agent <id>]... [--target <agent>=<path>]...
                      [--var KEY=VALUE]... [--import <path>] [--no-hooks] [--no-skill] [--no-wait]

Register this Machine with the browser, then set up its Targets, Variables, hooks and skill,
and sync. Safe to run again. Alias: login.

  --server <url>             The AgentSync server
  --nickname <nickname>      The Machine nickname (default: asked, or the hostname);
                             on a registered Machine, renames it
  --agent <id>               Sync this agent: claude, codex or pi (default: those found here)
  --target <agent>=<path>    Sync another agent's file, e.g. gemini=~/.gemini/GEMINI.md
  --var KEY=VALUE            Set a Variable on this Machine
  --import <path>            On the account's first Machine, start the Template from this file
  --no-hooks, --no-skill     Do not install the SessionStart hooks or the agentsync skill
  --no-wait                  Print the approval link and exit; run init again once approved

Examples:
  agentsync init --server https://agentsync.example.com
  agentsync init --agent claude --var shell=fish`,
  sync: `Usage: agentsync sync [--overwrite | --keep] [--verbose]

Render the Template into every Target on this Machine. A Target edited by hand has Drift:
at a terminal you choose what happens; otherwise it is left alone and sync exits 3.

  --overwrite   Replace Drifted Targets with the Template, keeping <target>.agentsync-backup
  --keep        Leave Drifted Targets as they are
  --verbose     List every file written and show Drift diffs
  --hook <agent> Used by agent hooks: one line, never prompts, always exits 0

Examples:
  agentsync sync
  agentsync sync --keep --json`,
  status: `Usage: agentsync status [--verbose]

Show this Machine, the Template revision, each Target's state, and open Conflicts. Writes nothing.`,
  edit: `Usage: agentsync edit [--file <path> --base <revision>]

Open the Template in $EDITOR and save it as the next revision. If the Template changed
meanwhile, the edit is kept as a Conflict (exit 4).

  --file <path>       Save this file instead of opening an editor
  --base <revision>   The Template revision the file was edited from (required with --file)

Examples:
  agentsync edit
  agentsync template --json > t.json && agentsync edit --file AGENTS.md --base 7`,
  template: `Usage: agentsync template [--out <path>]

Print the Template, or write it to a file.`,
  vars: `Usage: agentsync vars [--var KEY=VALUE]... [--unset KEY]...

Show this Machine's Variables as KEY=VALUE lines, or change them.

Example:
  agentsync vars --var shell=fish --unset editor`,
  conflict: `Usage: agentsync conflict list
       agentsync conflict get <id> [--out <path>]
       agentsync conflict resolve <id> <file> [--base <revision>]

Work with open Conflicts: Template edits kept because the Template changed meanwhile.
Run agentsync help conflict <action> for one action.`,
  'conflict list': `Usage: agentsync conflict list

List open Conflicts with their IDs and browser URLs.`,
  'conflict get': `Usage: agentsync conflict get <id> [--out <path>]

Print a Conflict: the Template with git-style markers around the lines both edits changed.`,
  'conflict resolve': `Usage: agentsync conflict resolve <id> <file> [--base <revision>]

Save a merged file as the resolution. It must have no markers left and must parse.

  --base <revision>   The Template revision it was merged against (default: the Conflict's)`,
  rename: `Usage: agentsync rename <nickname>

Change this Machine's nickname: 1 to 100 characters; quote one with spaces. It keeps its
identity, token, Variables and Targets, and no Target is written.

Use {{machine.nickname}} in your Template for this name; {{machine.hostname}} is the
computer's own hostname, which AgentSync updates on init.
Changes apply to Targets on the next sync.

Examples:
  agentsync rename "Home server"
  agentsync rename "Work laptop" --json`,
  logout: `Usage: agentsync logout

Revoke this Machine and remove its token, plus the hooks and skill files AgentSync installed
that nobody changed. Targets stay.`,
};
COMMAND_HELP.login = COMMAND_HELP.init!;

/** The help for `words` (a command and maybe an action), most specific first; the root help otherwise. */
function helpFor(words: string[]): string {
  const [command, action] = words;
  return COMMAND_HELP[`${command} ${action}`] ?? COMMAND_HELP[command ?? ''] ?? HELP;
}

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
  rename,
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
      verbose: { type: 'boolean', default: false },
      color: { type: 'boolean', default: true },
      progress: { type: 'boolean', default: true },
      plain: { type: 'boolean', default: false },
      server: { type: 'string' },
      nickname: { type: 'string' },
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
    io.out(helpFor(name === 'help' ? args : positionals));
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
      const color = flags.color && !flags.plain && !io.env.NO_COLOR && io.tty.stderr && io.env.TERM !== 'dumb';
      io.err(palette(color, false).red(`agentsync: ${message}`));
    }
    return code;
  }
}
