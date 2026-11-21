---
name: agentsync-skills
description: Installs the agent Skills the user picked on the AgentSync dashboard onto this Machine with `agentsync skills sync` and `agentsync skills status`. Use when an `AgentSync:` line reports Skills to install or update, when the user wants their synced Skills on this Machine, or when `agentsync skills sync` exits 1 or 3.
---

# AgentSync Skills

Skills are agent skills the user picks on the AgentSync dashboard from public GitHub repositories. Each is pinned to one commit, and goes to every Machine or to the ones chosen there. Adding, removing, assigning and updating Skills happens only on the dashboard; from here you can only install what is set for this Machine.

Run every command with `--json --yes`. Stdout is one JSON document (`ok`, the data, or `error.message`).

- `agentsync skills status --json` lists each Skill with its `state`: `install` or `update` (waiting for `skills sync`), `unchanged`/`adopt` (installed), `remove`, `drifted` (edited by hand), `blocked` (a skill folder of the same name that AgentSync didn't install is in the way). `agentsync sync --json` has the counts in `skills`.
- `agentsync skills sync --json` installs, updates and removes them with the official `skills` CLI and reports each in `skills` (`installed`, `updated`, `adopted`, `removed`, `unchanged`, `failed` with `error`, `blocked`, `drifted`). It takes a few seconds per repository.

The session-start hook only reports waiting Skills (`N Skills to install, M updates`), it never installs them. Tell the user, and run `agentsync skills sync --json` if they want them now.

Branch on the exit code of `skills sync`:

- **0**: done.
- **3**: something was left alone. A `blocked` Skill has a folder of its name that AgentSync didn't install (`~/.agents/skills/<name>` or `~/.claude/skills/<name>`), or one the `skills` lock says came from another repository; the user moves or renames it, and the folder stays until they say otherwise. `--overwrite` doesn't touch it. A `drifted` Skill was edited by hand: ask before running `agentsync skills sync --json --overwrite`, which replaces it (or removes it, if this Machine shouldn't have it).
- **1**: an install failed; `error` says why.
- **5**: the Machine is not registered or was revoked: `agentsync init`.
