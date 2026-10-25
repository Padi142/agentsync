# Machines and Variables

A **Machine** is a computer you've registered. Each one has its own nickname, Variables and Targets.

## Targets

A **Target** is a file a Machine writes the Template into, such as `~/.claude/CLAUDE.md`. `agentsync init` adds one for each agent it finds:

| Agent | Detected by | Target |
| --- | --- | --- |
| Claude Code | `~/.claude` (or `$CLAUDE_CONFIG_DIR`) | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex` (or `$CODEX_HOME`) | `~/.codex/AGENTS.md` |

Add a Target for any other agent with `--target`:

```sh
agentsync init --target cursor=~/.cursor/AGENTS.md
```

The Template is rendered once per Target, with `{{agent}}` set to that Target's agent. A symlinked Target, say from a dotfiles manager, stays a symlink: AgentSync writes the file it points to.

## Variables

Variables belong to one Machine. Set them on the Machine's page, or from its terminal:

```sh
agentsync vars                      # list them
agentsync vars --var editor=neovim  # set one
agentsync vars --unset editor       # remove one
```

Every save creates a revision. The Machine's page lists them and can restore an old one.

## Nicknames

A nickname is the name you give a Machine; the hostname is the computer's own. Rename a Machine on its page, or on the computer itself:

```sh
agentsync rename "Work laptop"
```

Nicknames don't have to be unique.

## Deleting a Machine

Deleting a Machine on the web stops it syncing at once. Its files stay as they are, but the server forgets its token, Variables and history. The web can't reach into the computer, so to register it again, run this on it:

```sh
agentsync logout && agentsync init --server <SERVER_URL>
```
