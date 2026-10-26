# Drift and Conflicts

Two things can stop a change from going through cleanly. Neither loses any text.

## Drift: a file was edited by hand

AgentSync owns its Targets. If you edit `~/.claude/CLAUDE.md` directly, that hand edit is **Drift**, and `sync` stops with exit code `3` instead of overwriting it.

Decide what to do with it:

- **Keep it for every computer.** Copy the change into the [Template](/), then sync.
- **Throw it away.** `agentsync sync --overwrite` writes the Template and keeps your edit in `<target>.agentsync-backup`.
- **Decide later.** `agentsync sync --keep` leaves the file alone for now.

Run interactively, `sync` asks you, and can hand the decision to Claude Code, Codex or pi. The hook never overwrites Drift; it reports it on the agent's first line.

## Conflicts: two edits overlapped

The Template is saved by revision. If it changed after you started editing (in another tab, on another Machine, or by an agent), your save doesn't overwrite it. Your edit is kept as a **Conflict** instead, and `agentsync edit` exits with code `4`.

Machines keep getting the current Template while a Conflict is open.

### Resolving on the web

Open [Conflicts](/conflicts). Lines only one side changed are already merged. For lines both sides changed:

1. Pick a side for each region, or use both.
2. Edit the merged text if you need to.
3. Choose **Save and resolve**. It becomes the next Template revision.

If someone saves yet again while you merge, their changes are merged into yours and any new overlaps are marked.

### Resolving in a terminal

```sh
agentsync conflict list
agentsync conflict get <id> --out merge.md
# edit merge.md and remove the markers
agentsync conflict resolve <id> merge.md
```

`resolve` refuses a file that still has `<<<<<<<` or `>>>>>>>` markers, and warns about lines that are exactly `=======`, since those also underline Markdown headings.
