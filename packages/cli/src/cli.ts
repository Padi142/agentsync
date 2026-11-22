import { parseArgs } from 'node:util';
import { ORPCError } from '@orpc/client';
import { Context, type Flags, type Outcome } from './context.js';
import { CliError, describeError, EXIT, exitCodeFor, usage } from './exit.js';
import type { Io } from './io.js';
import { palette } from './style.js';
import { init } from './commands/init.js';
import { conflict } from './commands/conflict.js';
import { edit } from './commands/edit.js';
import { history } from './commands/history.js';
import { hookOutput, sync } from './commands/sync.js';
import { logout } from './commands/logout.js';
import { rename } from './commands/rename.js';
import { skills } from './commands/skills.js';
import { space, USAGE as SPACE_USAGE, type SpaceFlags } from './commands/space.js';
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
  history     Show when AgentSync changed the Targets on this Machine, and why
  edit        Edit the Template in $EDITOR, or save a file as the next revision
  template    Print the Template
  vars        Show or change this Machine's Variables
  conflict    List, get, or resolve open Conflicts
  skills      Install this Machine's Skills (skills sync), show them (skills status),
              or ask to add some from GitHub (skills add)
  space       Share files as a live Space, or read one from its Share Link
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
Exit codes: 0 ok, 1 error, 2 usage, 3 Drift (or a blocked Skill), 4 Conflict, 5 auth,
6 waiting for approval (skills add), 130 cancelled.`;

const COMMAND_HELP: Record<string, string> = {
  init: `Usage: agentsync init [--server <url>] [--nickname <nickname>] [--agent <id>]... [--target <agent>=<path>]...
                      [--var KEY=VALUE]... [--import <path>] [--no-hooks] [--no-skill] [--skills | --no-skills]
                      [--no-wait]

Register this Machine with the browser, then set up its Targets, Variables, hooks and skills,
and sync. Safe to run again. Alias: login.

  --server <url>             The AgentSync server
  --nickname <nickname>      The Machine nickname (default: asked, or the hostname);
                             on a registered Machine, renames it
  --agent <id>               Sync this agent: claude, codex, pi or opencode (default: those found here)
  --target <agent>=<path>    Sync another agent's file, e.g. gemini=~/.gemini/GEMINI.md
  --var KEY=VALUE            Set a Variable on this Machine
  --import <path>            On the account's first Machine, start the Template from this file
  --no-hooks, --no-skill     Do not install the SessionStart hooks or the agentsync skills
  --skills, --no-skills      Install the account's Skills for this Machine now, or don't
                             (default: asked; skipped without a terminal)
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
  history: `Usage: agentsync history [--agent <id>]... [--limit <n>] [--verbose]

Show every change AgentSync made to this Machine's Targets, newest first: when, what ran
the sync (an agent's session start, \`agentsync sync\` or \`agentsync init\`), and which
Template or Variables revision it brought. Reads only this Machine's local log.

  --agent <id>    Only this agent's Targets, e.g. claude
  --limit <n>     Show the newest n syncs (default: 10)
  --verbose       Show each change as a diff

Examples:
  agentsync history
  agentsync history --agent claude --verbose --limit 1`,
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
  skills: `Usage: agentsync skills sync [--overwrite]
       agentsync skills status
       agentsync skills add <owner/repo> [names…] [--no-wait] [--no-sync]

Skills are agent skills picked on the web dashboard, each pinned to a commit of a GitHub
repository. skills sync installs and removes them, with the official \`skills\` CLI. It only
replaces or removes folders AgentSync installed: a folder of the same name that you wrote or
installed yourself blocks the Skill, and a Skill edited by hand is left alone (exit 3) until
--overwrite. skills add asks for new Skills, which you approve in the browser, then installs them.

  --overwrite   Replace or remove Skills edited by hand

Examples:
  agentsync skills sync
  agentsync skills status --json`,
  'skills sync': `Usage: agentsync skills sync [--overwrite]

Install, update and remove this Machine's Skills to match their Pins, then tell the server.
Exit 3 if a Skill is blocked by your own folder or was edited by hand, 1 if an install failed.

  --overwrite   Replace or remove Skills edited by hand`,
  'skills status': `Usage: agentsync skills status

Show each of this Machine's Skills against its Pin, without changing anything.`,
  'skills add': `Usage: agentsync skills add <owner/repo | https://github.com/owner/repo> [names…] [--no-wait] [--no-sync]

Ask to add Skills from a public GitHub repository: the named ones, or every skill it has. This
Machine can't add them itself: it prints a link where you approve them in the browser, choosing
which to add and their Machines, and waits up to 10 minutes. Then it installs the ones approved
on this Machine. Running the same command again resumes the same request.

  --no-wait   Print the link and exit 6 without waiting
  --no-sync   Don't install what was approved; skills sync does it later

Exit 6 if the request is still waiting (it expires after 24 hours), 1 if it was rejected,
2 if the repository has no skill of a name given, 3 if an approved Skill is blocked here.

Examples:
  agentsync skills add t3dotgg/tstack
  agentsync skills add https://github.com/t3dotgg/tstack babysit-pr --no-wait --json`,
  space: `Usage: ${SPACE_USAGE.create}
       ${SPACE_USAGE.put}
       ${SPACE_USAGE.push}
       ${SPACE_USAGE.rm}
       ${SPACE_USAGE.update}
       ${SPACE_USAGE.delete}
       ${SPACE_USAGE.inspect}
       ${SPACE_USAGE.get}
       ${SPACE_USAGE.pull}

A Space is a live collection of files on the AgentSync server, shared with a Share Link that
anyone can open without an account. create needs this Machine registered; it prints the Space's
Write Token once, which put, push, rm, update and delete need: pass it with --token or set
AGENTSYNC_SPACE_TOKEN. It is never saved. inspect, get and pull need only the Share Link.
Run agentsync help space <action> for one action.

Examples:
  agentsync space create ./report --summary "Benchmark results"
  AGENTSYNC_SPACE_TOKEN=asw_… agentsync space push <id> ./report
  agentsync space pull https://agentsync.example.com/s/<token> ./report --watch`,
  'space create': `Usage: ${SPACE_USAGE.create}

Create a Space and upload a file or a whole directory into it. Prints the Share Link, the Space id,
and the Write Token, which is shown only this once and never saved.

  --title <title>       Default: the file or directory name
  --summary <text>      A line for readers and agents about what the Space holds
  --expires <n>d|never  How long the Share Link works (default 7d, at most 365d)

Symlinks, .git, node_modules and .DS_Store are skipped. A file can be at most 25 MB, a Space 100 MB and 500 files.`,
  'space put': `Usage: ${SPACE_USAGE.put}

Upload one file, replacing any file at remote-path (default: the file's name).`,
  'space push': `Usage: ${SPACE_USAGE.push}

Make the Space hold exactly local-dir: upload new and changed files (by SHA-256) and delete remote
files that aren't there. Deletions are listed and confirmed first; --yes or --json skips that.`,
  'space rm': `Usage: ${SPACE_USAGE.rm}

Delete one file from the Space.`,
  'space update': `Usage: ${SPACE_USAGE.update}

Change the title, the summary (--summary "" clears it) or how long the Share Link works.`,
  'space delete': `Usage: ${SPACE_USAGE.delete}

Delete the Space, its files and its Share Link. Asks first; --yes skips that (and is required without a terminal).`,
  'space inspect': `Usage: ${SPACE_USAGE.inspect}

Show a Space's title, summary, expiry and files. Needs no account. --json gives the Space in "space".`,
  'space get': `Usage: ${SPACE_USAGE.get}

Download one file. Without --out a text file is printed to stdout (in "text" with --json); a binary
file needs --out. --out may be a directory.`,
  'space pull': `Usage: ${SPACE_USAGE.pull}

Download every file into local-dir, skipping those already the same. Local files the Space doesn't
have are left alone.

  --watch   Keep local-dir in step as the Space changes, until Ctrl+C or the Share Link stops working`,
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
that nobody changed. Targets and installed Skills stay.`,
};
COMMAND_HELP.login = COMMAND_HELP.init!;

/** The help for `words` (a command and maybe an action), most specific first; the root help otherwise. */
function helpFor(words: string[]): string {
  const [command, action] = words;
  return COMMAND_HELP[`${command} ${action}`] ?? COMMAND_HELP[command ?? ''] ?? HELP;
}

/** A command. Most take only `ctx`; `space` also reads its own flags. */
type Command = (ctx: Context, flags: SpaceFlags) => Promise<Outcome>;

const COMMANDS: Record<string, Command> = {
  init,
  login: init,
  sync,
  edit,
  template,
  conflict,
  vars,
  status,
  history,
  rename,
  skills,
  space,
  logout,
};

function parse(argv: string[]): { flags: Flags & SpaceFlags; positionals: string[]; help: boolean; version: boolean } {
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
      skills: { type: 'boolean' },
      wait: { type: 'boolean', default: true },
      sync: { type: 'boolean', default: true },
      file: { type: 'string' },
      base: { type: 'string' },
      out: { type: 'string' },
      limit: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      expires: { type: 'string' },
      token: { type: 'string' },
      watch: { type: 'boolean', default: false },
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
    const { code = EXIT.ok, data = {} } = await command(ctx, flags);
    // A hook prints its own output, which must be all of stdout.
    if (flags.json && flags.hook === undefined) io.out(JSON.stringify({ ok: code === EXIT.ok, ...data }, null, 2));
    return code;
  } catch (error) {
    const code = exitCodeFor(error);
    const message = describeError(error);
    if (flags.hook !== undefined) {
      // Hooks fail open: an agent session must start whatever happens here.
      io.out(hookOutput(flags.hook, `AgentSync: ${message}`));
      return EXIT.ok;
    }
    if (flags.json) {
      const details = error instanceof CliError ? error.details : error instanceof ORPCError ? { code: error.code } : {};
      io.out(JSON.stringify({ ok: false, error: { message, exitCode: code, ...details } }, null, 2));
    } else {
      const color = flags.color && !flags.plain && !io.env.NO_COLOR && io.tty.stderr && io.env.TERM !== 'dumb';
      io.err(palette(color, false).red(`agentsync: ${message}`));
    }
    return code;
  }
}
