# Hooks and agents

## The SessionStart hook

`agentsync init` adds a `SessionStart` hook to each agent it finds. The hook runs `agentsync sync --hook <agent>`:

| Agent | Hook file |
| --- | --- |
| Claude Code | `~/.claude/settings.json` |
| Codex | `~/.codex/hooks.json` |

Your other settings and hooks are kept. Codex skips a new hook until you trust it: open Codex and run `/hooks` once.

The hook is built to never get in your way. It never prompts, waits at most 2 seconds for the server, keeps your files if the server can't be reached, and always exits successfully. It prints at most one line starting with `AgentSync:`, which the agent sees. That line reports updated files, Drift it skipped, Variables that aren't set, and open Conflicts.

## Changes apply from the next session

Both agents read their instructions before a `SessionStart` hook can change them. So when the hook writes a new Template, the session that's starting still has the old one, and the next session gets the new one.

To soften this, the hook's line names the updated file and tells the agent to read it if the current instructions matter.

## The agent skill

`init` also installs an `agentsync` skill, so your agents know how to work with AgentSync: the commands, the exit codes, the Template syntax, how to fold Drift into the Template, and how to resolve Conflicts. It goes in `~/.claude/skills/agentsync/` for Claude Code and `~/.agents/skills/agentsync/` for Codex.

## Removing AgentSync

```sh
agentsync logout
```

This deletes the Machine on the server and removes the hooks and skill files AgentSync installed, as long as nobody changed them. Your instruction files stay as they are.
