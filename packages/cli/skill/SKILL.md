---
name: agentsync
description: AgentSync CLI that syncs the user's Global Instructions (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md) across Machines. Use when changing those global instruction files, when an `AgentSync:` line reports an update, Drift or a Conflict, or when an `agentsync` command exits 3, 4 or 5.
---

# AgentSync

On this Machine, the Global Instructions files are **Targets**: Rendered output of one **Template** that lives on the AgentSync server, plus this Machine's **Variables**. Every Machine of the user Renders the same Template, so a change to the instructions is a change to the Template, and `agentsync sync` writes it into the Targets.

Run every command with `--json --yes`. Stdout is one JSON document (`ok`, the data, or `error.message`). Branch on the exit code:

| Code | Meaning | Next |
|---|---|---|
| 0 | ok | |
| 1 | error | read `error.message` |
| 2 | usage | fix the command (`agentsync --help`) |
| 3 | Drift | [Fold Drift into the Template](#fold-drift-into-the-template) |
| 4 | Conflict | [Resolve a Conflict](#resolve-a-conflict) |
| 5 | auth | the Machine is not registered or was revoked: `agentsync init` |

## Template syntax

- `{{name}}` is a Variable of this Machine. A missing one Renders as empty, with a warning.
- Built-in Variables: `{{machine.name}}`, `{{machine.os}}` (`macos`, `linux`, `windows`), `{{agent}}` (`claude`, `codex`, …: the agent whose Target is being Rendered).
- `{{if agent == "codex"}} … {{else}} … {{end}}`, also `!=`. Blocks nest. There is no `and`/`or`.
- `\{{` is a literal `{{`.
- A malformed Expression is a hard error: the save is rejected with its line and column.

## Change the Global Instructions

1. `agentsync template --json` gives `text` and `revision`. Write `text` to a scratch file.
2. Edit the scratch file. Text for every Machine and agent stays plain. Text for some agents or Machines goes inside an `{{if …}}` block. A value that differs per Machine becomes a Variable: `agentsync vars --json --var KEY=VALUE`.
3. `agentsync edit --json --file <scratch file> --base <revision>`. Exit 4 means someone else changed the Template meanwhile: [resolve the Conflict](#resolve-a-conflict).
4. `agentsync sync --json` writes the new revision into this Machine's Targets. The change is done when every Target in `targets` is `written` or `unchanged`.

## Fold Drift into the Template

Drift is a Target that was edited by hand since AgentSync wrote it. `agentsync sync --json` exits 3 and lists it in `targets` with `status: "drift"` and a `diff` from what AgentSync wrote to what is on disk.

1. Show the user the diff and ask which they want:
   - **Keep the edit for every Machine**: put the `+` lines into the Template ([Change the Global Instructions](#change-the-global-instructions)), then run `agentsync sync --json`. The Target reads `unchanged` once the Template Renders to exactly the edited file. If it still reads `drift`, compare the diff again.
   - **Discard it**: `agentsync sync --json --overwrite`. The hand-edited file is kept as `<target>.agentsync-backup`.
   - **Leave it for now**: `agentsync sync --json --keep`.
2. Done when `agentsync sync --json` exits 0.

## Resolve a Conflict

A Conflict is a Template edit saved after the Template had already moved on. The server keeps it as one text with git-style `<<<<<<<` / `=======` / `>>>>>>>` markers around the lines both edits changed. Machines keep Rendering the current Template until the Conflict is resolved.

1. `agentsync conflict list --json` lists open Conflicts, each with an `id` and a `url`.
2. The user can resolve it in the browser at its `url`. To resolve it here instead, run `agentsync conflict get <id> --out <file>`.
3. Merge both sides into one Template and remove every marker line. When the two edits changed different lines, the text has no markers: read it through anyway, because it still needs a decision. A lone `=======` line that underlines a Markdown heading is fine (the CLI warns about it, nothing more).
4. `agentsync conflict resolve <id> <file> --json`. Exit 4 means the Template moved on again: get it with `agentsync template --json`, merge again, and pass `--base <revision>`.
5. Done when it exits 0. Then `agentsync sync --json`.

## `AgentSync:` lines at session start

The SessionStart hook runs `agentsync sync --hook <agent>` and prints at most one line:

- **updated `<path>`**: the agent loaded its instructions before the hook ran, so this session has the previous version. Read `<path>` if the current instructions matter for the task.
- **Drift**: the Target was skipped. Offer to [fold it into the Template](#fold-drift-into-the-template).
- **open Conflict**: offer to [resolve it](#resolve-a-conflict).
- **kept the existing instructions**: the server was unreachable or the Machine is not registered. The files on disk are unchanged.
