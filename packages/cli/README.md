# agentsync

The AgentSync CLI. It Renders your one Template (stored on the AgentSync server) with
this Machine's Variables into every Target, such as `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md`, and keeps them current from each agent's `SessionStart` hook.
See `GLOSSARY.md` at the repo root for the terms.

```sh
npm install -g agentsync
agentsync init --server https://your-agentsync-server
```

Run `agentsync --help` for the commands, and `agentsync help <command>` for one command's flags.

## Commands

| Command | What it does |
|---|---|
| `init` (alias `login`) | Registers the Machine with the WorkOS device flow, asks for a Machine nickname (hostname prefilled; `--name` skips it), detects agents, saves Variables (`--var`), imports an existing file on the account's first Machine, installs hooks and the skill, then syncs. Safe to run again. |
| `sync` | Renders the Template into each Target. Drift stops it with exit 3, unless `--overwrite` (keeps `<target>.agentsync-backup`) or `--keep` is passed, or you choose at the prompt. |
| `edit` | Opens the Template in `$EDITOR` and saves it. `--file <path> --base <revision>` does the same without an editor. When the Template changed meanwhile, the edit is kept as a Conflict (exit 4). |
| `template` | Prints the Template, or writes it with `--out`. |
| `vars` | Shows the Machine's Variables, or changes them with `--var KEY=VALUE` and `--unset KEY`. |
| `conflict list \| get <id> \| resolve <id> <file>` | Works with open Conflicts. `resolve` refuses leftover markers and warns about lone `=======` lines. |
| `status` | Shows each Target's state and open Conflicts, without writing. |
| `rename <nickname>` | Changes the Machine's nickname (also `init --name` on a registered Machine). Writes no Target; name-dependent Template output changes on the next `sync`. |
| `logout` | Revokes the Machine and removes its token, plus the hooks and skill files AgentSync installed that nobody changed. Targets stay. |

A Machine deleted on the web stops syncing at once: ordinary commands exit 5 and hooks keep the existing files. The web cannot remove local config, hooks or files, so run `agentsync logout` and then `agentsync init` on it to register it again (it gets a new ID).

Every command takes `--json` (one JSON document on stdout, progress on stderr),
`--yes` (never prompt) and `--server`, plus display flags:

| Flag | Effect |
|---|---|
| `--verbose` | Per-file steps, the server, and full Drift diffs |
| `--no-color` | No color on either stream (so does a nonempty `NO_COLOR`) |
| `--no-progress` | No spinner while waiting |
| `--plain` | No color, symbols or animation; numbered choices instead of arrow-key menus |

Prompts appear only when stdin, stdout and stderr are all terminals, outside CI and `TERM=dumb`,
and without `--yes`, `--json` or `--hook`. Prompts and spinners go to stderr; results to stdout.

| Exit code | Meaning |
|---|---|
| 0 | ok |
| 1 | error |
| 2 | usage |
| 3 | Drift |
| 4 | Conflict |
| 5 | auth: not registered, revoked, or registration denied, expired or invalid |
| 130 | cancelled with Ctrl+C at a prompt; completed writes are remembered and edit drafts kept |

## How it works

- **Machine token.** `init` runs the WorkOS AuthKit CLI Auth device flow through the
  server, which then issues a per-Machine token. It is stored in
  `~/.config/agentsync/config.json` (or `$XDG_CONFIG_HOME/agentsync`, or
  `$AGENTSYNC_CONFIG_DIR`) with mode `0600`, and sent as `Authorization: Bearer`. The CLI
  sends no Origin header and no cookies, which is what lets it past the server's CSRF check.
- **Agents.** Claude Code is detected by `~/.claude` (or `$CLAUDE_CONFIG_DIR`), Codex by
  `~/.codex` (or `$CODEX_HOME`). `--target <agent>=<path>` adds a Target for any other
  agent. Targets are stored on the server as `~/…`, so they read the same on every Machine.
  A Target path must be absolute or start with `~/`: hooks run in whatever project the
  agent opens, so a relative path would mean a different file each time. `sync` skips one
  (set from elsewhere) with a warning.
- **Writing files.** Every write goes through an exclusively created temporary file and a
  rename. A file keeps its mode, new hook files are `0600`, and the config is always `0600`
  in a `0700` directory. A symlinked Target (e.g. from a dotfiles manager) stays a symlink:
  AgentSync writes the file it points to.
- **Drift.** The config keeps the text last written to each Target, not just a hash, so a
  Drift diff shows only the hand edit. A Template change made on another Machine is never
  shown as a removal. A Target that already holds the new Rendered output is not Drift.
  Overwriting a Drifted Target copies it to `<target>.agentsync-backup` first, replacing
  any earlier backup there.
- **Drafts.** Interactive `edit`, and fixing a Conflict here, work on a draft in
  `~/.config/agentsync/drafts/`. It is deleted once the edit is saved (as a revision or a
  Conflict) or given up. If saving fails, it is kept, and the error names the file and the
  command that saves it.
- **Partial failure.** A Target that cannot be read or written gets `status: "error"`, and
  `sync` still writes the others, remembers them, and exits 1. A new Target file gets the
  usual mode for your umask.
- **First run.** When the account has no Template yet, `init` imports `--import <path>`,
  or else the largest existing Target, as revision 1. Every `{{` in it is escaped, so it
  Renders back to exactly the same text. Any other existing file that differs is Drift.
- **Agents running `init`.** An agent's shell shows output only once a command exits, so
  `init --no-wait` prints the device code and exits, and the next `init` resumes polling.
  `setup-prompt.md` is the text the web app's Setup page gives to an agent. Replace every
  `<SERVER_URL>` in it with the server's origin.
- **Hand-off.** At a terminal, Drift and Conflicts can be handed to an agent: the CLI
  starts `claude` or `codex` with a prompt. Your choice is remembered per Machine.

## Hooks

`init` adds a `SessionStart` hook that runs `agentsync sync --hook <agent>`:

- Claude Code: `~/.claude/settings.json`. Existing settings and hooks are kept.
- Codex: `~/.codex/hooks.json`. Codex skips a new hook until you trust it once: open
  Codex and run `/hooks`.

The hook command is `agentsync` when the CLI is installed on `PATH`, otherwise the
absolute Node and script path (`npx`'s temporary directory does not count). The config
records the exact handler it installed. Re-running `init` replaces that handler, and
`logout` removes it, only while it is unchanged. Any other handler, even one that mentions
`agentsync`, is left alone.

Hook mode fails open. It never prompts, waits at most 2 seconds for the server, keeps the
existing files when it cannot reach the server, always exits 0, and prints at most one
`AgentSync: …` line. Both agents add a SessionStart hook's stdout to the session's
context, so the agent sees that line. It reports updated Targets, skipped Drift, unset
Variables and open Conflicts (with a link).

### Does a change apply to the current session? No: there is a one-session lag

Both agents read their instructions file before the `SessionStart` hook's write can
reach them, so a Template change the hook writes takes effect from the next session.

- **Claude Code.** The [memory docs](https://code.claude.com/docs/en/memory) say
  CLAUDE.md files above the working directory "are loaded at launch", and the
  [hooks docs](https://code.claude.com/docs/en/hooks#sessionstart) say SessionStart hooks
  "run in the background" at launch; Claude's first response waits for them "so their
  context reaches Claude". The docs do not state the order of the two outright, but they
  say skill discovery "normally runs before SessionStart hooks finish". Tested with Claude Code 2.1.310
  (`claude -p --settings` with a SessionStart hook that rewrites `CLAUDE.md`): the session
  answered from the old file.
- **Codex.** The [AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)
  says Codex "builds an instruction chain when it starts (once per run; in the TUI this
  usually means once per launched session)". Tested with codex-cli 0.164.0 (`codex exec`
  with a `~/.codex/hooks.json` SessionStart hook that rewrites `AGENTS.md`): the session's
  rollout file records the old `AGENTS.md` text, even though the hook had already run.

To soften the lag, the hook's line names the updated Target and tells the agent to read
it when the current instructions matter. The skill says the same.

## Agent skill

`init` installs `skill/SKILL.md` as the `agentsync` skill: `~/.claude/skills/agentsync/`
for Claude Code and `~/.agents/skills/agentsync/` for Codex. The config keeps a SHA-256 of
each skill file it writes. `init` updates, and `logout` removes, only a file that still
matches it. A skill file AgentSync did not write, or that was changed since, is left alone
with a warning. A symlinked `skills/agentsync/` directory stays: `logout` removes only the
file inside it. It covers the commands, exit
codes, Template syntax, folding Drift into the Template, and resolving Conflicts.

## Development

```sh
pnpm --filter agentsync test       # vitest, against an in-memory server built from the contract
pnpm --filter agentsync build      # tsc to dist/
node packages/cli/dist/index.js --help
```

The root `typecheck`, `test` and `build` scripts build `@agentsync/template` and
`@agentsync/contract` first, because the CLI imports their `dist/`.
