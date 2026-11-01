# Skills are pinned to commits and kept separate from the Template

A Skill comes from someone else's GitHub repository, so it is code AgentSync distributes to every Machine on the user's behalf. Each Skill therefore installs one Pin, an exact commit plus the git tree hash of its folder, which the server resolves from GitHub itself; a Machine never follows a branch. A Pin moves only by a deliberate update on the dashboard, or by an opt-in automatic update that holds back versions skills.sh audits rate High or Critical, or has not audited. Skills have their own state and their own command (`agentsync skills sync`), apart from the Template and `agentsync sync`, so that syncing instructions, which agents do on their own, never downloads code. Only a signed-in browser changes Skills; a Machine token reads its own list and reports scans, so a stolen token cannot push a Skill to other Machines.

## Considered Options

- **Follow the default branch**: rejected because the upstream author, or whoever takes over their account, could change what runs on every Machine without the user seeing it.
- **Install from the SessionStart hook**: rejected because installs clone repositories (seconds, not the hook's 2 s budget) and would download code without anyone asking; the hook only scans and reports.
- **Skills as part of the Template (or its revisions)**: rejected because instructions and code have different trust and update rules, and a Template edit must not change what is installed.
- **Serve Skill files from the AgentSync server**: rejected in favour of the official `skills` CLI (pinned to an exact version, telemetry off), which keeps installs identical to `npx skills add` and its lock file correct.
