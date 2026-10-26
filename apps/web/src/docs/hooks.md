# Hooks and agents

## The hook

`agentsync init` adds a hook to each agent it finds. It runs `agentsync sync --hook <agent>` when a session starts:

| Agent | Hook |
| --- | --- |
| Claude Code | A `SessionStart` hook in `~/.claude/settings.json` |
| Codex | A `SessionStart` hook in `~/.codex/hooks.json` |
| pi | An extension, `~/.pi/agent/extensions/agentsync.ts` |

Your other settings and hooks are kept. Codex skips a new hook until you trust it: open Codex and run `/hooks` once. pi loads the extension by itself.

The hook is built to never get in your way. It never prompts, waits at most 2 seconds for the server, keeps your files if the server can't be reached, and always exits successfully. It prints at most one line starting with `AgentSync:`, which the agent sees. That line reports updated files, Drift it skipped, Variables that aren't set, and open Conflicts.

## When a change applies

Claude Code and Codex read their instructions before a `SessionStart` hook can change them. So when the hook writes a new Template, the session that's starting still has the old one, and the next session gets the new one. To soften this, the hook's line names the updated file and tells the agent to read it if the current instructions matter.

pi waits for the extension before it reads its instructions, so a pi session gets the new Template as it starts.

## The agent skill

`init` also installs an `agentsync` skill, so your agents know how to work with AgentSync: the commands, the exit codes, the Template syntax, how to fold Drift into the Template, and how to resolve Conflicts. It goes in `~/.claude/skills/agentsync/` for Claude Code and `~/.agents/skills/agentsync/` for Codex and pi.

## Removing AgentSync

```sh
agentsync logout
```

This deletes the Machine on the server and removes the hooks and skill files AgentSync installed, as long as nobody changed them. Your instruction files stay as they are.
