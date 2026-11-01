# AgentSync

AgentSync keeps a user's agent instructions (`AGENTS.md`, `CLAUDE.md`, and similar) consistent across every computer they work on, with the AgentSync server holding the canonical copy.

## Language

### Scope

**Global Instructions**:
User-level instructions that apply to every project on a Machine, such as `~/.agents/AGENTS.md` or `~/.claude/CLAUDE.md`. The only kind of instructions AgentSync syncs today.
_Avoid_: User instructions, home instructions

**Project Instructions**:
Instructions committed inside a repository that apply only to that project. Not synced by AgentSync yet; they stay under the project's own version control.
_Avoid_: Repo instructions, local instructions

### Machines

**Machine**:
A computer that a user has registered with their AgentSync account and that receives their instructions.
_Avoid_: Device, host, client, computer

**Machine token**:
The secret a Machine sends to the AgentSync server to act for its user, issued once at registration and deleted when the Machine is revoked. It can read and write the user's shared Template and Conflicts, but only its own Machine record and Variables.
_Avoid_: API key, device token, access token

### Rendering

**Template**:
The single canonical source of a user's Global Instructions, stored on the AgentSync server and containing Expressions. Each user has exactly one.
_Avoid_: Source, master file, "the global AGENTS.md"

**Expression**:
A marked region of a Template that is resolved differently depending on the Machine it is rendered for.
_Avoid_: Placeholder, tag, macro

**Variable**:
A named value set for one Machine, stored on the AgentSync server, and substituted into the Template when Rendering for that Machine.
_Avoid_: Dynamic variable, setting, override

**Built-in Variable**:
A Variable whose value AgentSync supplies from facts about the Machine (such as its name or OS) and the user cannot set. Built-in Variables live under the reserved `machine.` prefix.
_Avoid_: System variable, fact

**Render**:
To turn a Template into plain instructions for one specific Machine by resolving every Expression.
_Avoid_: Compile, build, apply

**Target**:
A path on a Machine where an agent reads its Global Instructions and where AgentSync writes the Rendered output, e.g. `~/.codex/AGENTS.md`. A Machine has one or more Targets.
_Avoid_: Destination, output file, location

**Conflict**:
A Template edit that was rejected because the Template changed since the edit began, kept on the AgentSync server until the user merges it into a new Template revision. Machines keep receiving the current Template while a Conflict is open.
_Avoid_: Merge conflict, collision

**Drift**:
A hand edit to a Target that differs from what AgentSync last wrote there. Rendered output is never edited in place; changes belong in the Template.
_Avoid_: Local change, divergence

### Skills

**Skill**:
An agent skill (a folder with a `SKILL.md`) that a user added to their AgentSync account from a public GitHub repository, with a Pin and the Machines it is assigned to: all Machines (including ones registered later) or a chosen set. Its name is unique in the account. Installed on a Machine only by `agentsync skills sync`, through the official `skills` CLI. Separate from the Template: a Template change never affects Skills.
_Avoid_: Plugin, package, extension

**Pin**:
The exact commit a Skill installs, with the git tree hash of its folder at that commit and the hash of the folder as the `skills` CLI installs it (which leaves out a few files, such as `metadata.json`). A Pin moves only when the user updates the Skill, or when an automatic update does; every move is kept in the Skill's history.
_Avoid_: Version, lock, ref

**Found Skill**:
A skill a scan saw on a Machine that is not a Skill in the account, e.g. one installed by hand with `npx skills add` or written locally. The dashboard offers to add one from public GitHub, pinned at the commit the Machine already has; a hand-written one is reported by name only.
_Avoid_: Unmanaged skill, local skill, orphan

**Skill Drift**:
A managed Skill's folder on a Machine that no longer matches its Pin. If it matches a newer commit of the same repository, the dashboard offers that commit as the new Pin; otherwise it is a hand edit, and `skills sync` replaces it only with `--overwrite`.
_Avoid_: Outdated skill, modified skill
