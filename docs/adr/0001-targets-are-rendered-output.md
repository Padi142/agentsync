# Targets are rendered output of a server-side Template

Each user has one Template stored on the AgentSync server, plus per-Machine Variables; the CLI Renders them into every Target on a Machine. Files like `~/.claude/CLAUDE.md` are therefore generated output and are never the source of truth: changes go into the Template (web editor or `agentsync edit`), and a hand edit to a Target is treated as Drift that the CLI refuses to overwrite silently. We chose this so machine-specific content can exist without making what is on disk diverge from what is synced.

## Considered Options

- **Reverse-rendering local edits back into the Template**: rejected because an edit that spans an Expression boundary has no unambiguous owner (shared text vs. a Machine's Variable).
- **Each Machine canonical, server as relay**: rejected because it makes conflict handling peer-to-peer and leaves the web editor as a second-class client.
- **Last write wins on Targets**: rejected because it silently destroys hand edits.
