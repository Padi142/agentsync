# The CLI

The CLI isn't published to npm yet. Until it is, build it from the repository (Node.js 22.12+, pnpm and git) and link it onto your PATH:

```sh
git clone https://github.com/Padi142/agentsync.git ~/agentsync
cd ~/agentsync
pnpm install && pnpm build
(cd packages/cli && npm link)
```

Keep the clone: the hooks run the CLI from it. To update, run `git pull && pnpm install && pnpm build` in it.

`agentsync --help` lists the commands, and `agentsync help <command>` shows one command's flags.

## Commands

| Command | What it does |
| --- | --- |
| `agentsync init` | Registers this computer, installs the hooks and the agent skill, then syncs. Safe to run again. |
| `agentsync sync` | Writes the Template into each Target now. |
| `agentsync status` | Shows each Target's state and open Conflicts, without writing anything. |
| `agentsync history` | Shows each time AgentSync changed a Target on this Machine: when, what ran it (an agent's session start or a command), and which Template revision it brought. `--verbose` adds the diffs. |
| `agentsync edit` | Opens the Template in `$EDITOR` and saves it. |
| `agentsync template` | Prints the Template. `--out <path>` writes it to a file. |
| `agentsync vars` | Lists this Machine's Variables. `--var KEY=VALUE` sets one, `--unset KEY` removes one. |
| `agentsync conflict list` | Lists open Conflicts. |
| `agentsync conflict get <id>` | Prints a Conflict's marked text. `--out <path>` writes it to a file. |
| `agentsync conflict resolve <id> <file>` | Saves a merged file as the next Template revision. |
| `agentsync rename <nickname>` | Renames this Machine. |
| `agentsync logout` | Deletes this Machine and removes the hooks and skill AgentSync installed. Targets stay. |

## Flags for every command

| Flag | Effect |
| --- | --- |
| `--json` | One JSON document on stdout; progress goes to stderr. |
| `--yes` | Never prompt. |
| `--server <url>` | The AgentSync server to use. |
| `--verbose` | Per-file steps, the server, and full Drift diffs. |
| `--no-color` | No color. So does a nonempty `NO_COLOR`. |
| `--no-progress` | No spinner while waiting. |
| `--plain` | No color, symbols or animation; numbered choices instead of arrow-key menus. |

Prompts only appear in an interactive terminal, outside CI, and without `--yes` or `--json`.

## Exit codes

Scripts and agents can branch on these:

| Code | Meaning |
| --- | --- |
| `0` | OK |
| `1` | Error |
| `2` | Wrong usage |
| `3` | Drift: a Target was edited by hand |
| `4` | Conflict: the Template changed while you edited it |
| `5` | Not signed in: not registered, deleted, or registration denied or expired |
| `130` | Cancelled with Ctrl+C |

## Where things live

The Machine token and settings are in `~/.config/agentsync/config.json` (or `$XDG_CONFIG_HOME/agentsync`, or `$AGENTSYNC_CONFIG_DIR`), readable only by you. Next to it, `history.jsonl` records every change AgentSync made to a Target on this Machine, with its diff; `agentsync history` reads it.
