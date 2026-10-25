# agentsync

The AgentSync CLI. It Renders your one Template (stored on the AgentSync server) with
this Machine's Variables into every Target, such as `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md`, and keeps them current from each agent's `SessionStart` hook.
See `GLOSSARY.md` at the repo root for the terms.

```sh
npm install -g agentsync
agentsync init --server https://your-agentsync-server
```

Run `agentsync --help` for every command and flag.

## Commands

| Command | What it does |
|---|---|
| `init` (alias `login`) | Registers the Machine with the WorkOS device flow, detects agents, saves Variables (`--var`), imports an existing file on the account's first Machine, installs hooks and the skill, then syncs. Safe to run again. |
| `sync` | Renders the Template into each Target. Drift stops it with exit 3, unless `--overwrite` (keeps `<target>.agentsync-backup`) or `--keep` is passed, or you choose at the prompt. |
| `edit` | Opens the Template in `$EDITOR` and saves it. `--file <path> --base <revision>` does the same without an editor. When the Template changed meanwhile, the edit is kept as a Conflict (exit 4). |
| `template` | Prints the Template, or writes it with `--out`. |
| `vars` | Shows the Machine's Variables, or changes them with `--var KEY=VALUE` and `--unset KEY`. |
| `conflict list \| get <id> \| resolve <id> <file>` | Works with open Conflicts. `resolve` refuses leftover markers and warns about lone `=======` lines. |
| `status` | Shows each Target's state and open Conflicts, without writing. |
| `logout` | Revokes the Machine and removes its token, hooks and skill. Targets stay. |

Every command takes `--json` (one JSON document on stdout, progress on stderr),
`--yes` (never prompt) and `--server`.

| Exit code | Meaning |
|---|---|
| 0 | ok |
| 1 | error |
| 2 | usage |
| 3 | Drift |
| 4 | Conflict |
| 5 | auth: not registered, revoked, or registration denied, expired or invalid |

## How it works

- **Machine token.** `init` runs the WorkOS AuthKit CLI Auth device flow through the
  server, which then issues a per-Machine token. It is stored in
  `~/.config/agentsync/config.json` (or `$XDG_CONFIG_HOME/agentsync`, or
  `$AGENTSYNC_CONFIG_DIR`) with mode `0600`, and sent as `Authorization: Bearer`. The CLI
  sends no Origin header and no cookies, which is what lets it past the server's CSRF check.
- **Agents.** Claude Code is detected by `~/.claude` (or `$CLAUDE_CONFIG_DIR`), Codex by
  `~/.codex` (or `$CODEX_HOME`). `--target <agent>=<path>` adds a Target for any other
  agent. Targets are stored on the server as `~/…`, so they read the same on every Machine.
- **Drift.** The config keeps the text last written to each Target, not just a hash, so a
  Drift diff shows only the hand edit. A Template change made on another Machine is never
  shown as a removal. A Target that already holds the new Rendered output is not Drift.
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
absolute Node and script path (`npx`'s temporary directory does not count).

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
for Claude Code and `~/.agents/skills/agentsync/` for Codex. It covers the commands, exit
codes, Template syntax, folding Drift into the Template, and resolving Conflicts.

## Development

```sh
pnpm --filter agentsync test       # vitest, against an in-memory server built from the contract
pnpm --filter agentsync build      # tsc to dist/
node packages/cli/dist/index.js --help
```

The root `typecheck`, `test` and `build` scripts build `@agentsync/template` and
`@agentsync/contract` first, because the CLI imports their `dist/`.
