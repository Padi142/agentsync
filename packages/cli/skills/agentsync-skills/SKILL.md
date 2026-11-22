---
name: agentsync-skills
description: Installs the agent Skills the user picked on the AgentSync dashboard onto this Machine with `agentsync skills sync` and `agentsync skills status`, and asks to add new ones with `agentsync skills add`. Use when an `AgentSync:` line reports Skills to install or update, when the user wants their synced Skills on this Machine, when the user asks to add skills from a GitHub repository, or when an `agentsync skills` command exits 1, 3 or 6.
---

# AgentSync Skills

Skills are agent skills the user picks on the AgentSync dashboard from public GitHub repositories. Each is pinned to one commit, and goes to every Machine or to the ones chosen there. Removing, assigning and updating Skills happens only on the dashboard. From here you install what is set for this Machine, and, when the user asks, request new ones for them to approve.

Run every command with `--json --yes`. Stdout is one JSON document (`ok`, the data, or `error.message`).

- `agentsync skills status --json` lists each Skill with its `state`: `install` or `update` (waiting for `skills sync`), `unchanged`/`adopt` (installed), `remove`, `drifted` (edited by hand), `blocked` (a skill folder of the same name that AgentSync didn't install is in the way). `agentsync sync --json` has the counts in `skills`.
- `agentsync skills sync --json` installs, updates and removes them with the official `skills` CLI and reports each in `skills` (`installed`, `updated`, `adopted`, `removed`, `unchanged`, `failed` with `error`, `blocked`, `drifted`). It takes a few seconds per repository.

The session-start hook only reports waiting Skills (`N Skills to install, M updates`), it never installs them. Tell the user, and run `agentsync skills sync --json` if they want them now.

Branch on the exit code of `skills sync`:

- **0**: done.
- **3**: something was left alone. A `blocked` Skill has a folder of its name that AgentSync didn't install (`~/.agents/skills/<name>` or `~/.claude/skills/<name>`), or one the `skills` lock says came from another repository; the user moves or renames it, and the folder stays until they say otherwise. `--overwrite` doesn't touch it. A `drifted` Skill was edited by hand: ask before running `agentsync skills sync --json --overwrite`, which replaces it (or removes it, if this Machine shouldn't have it).
- **1**: an install failed; `error` says why.
- **5**: the Machine is not registered or was revoked: `agentsync init`.

## Asking for new Skills

Run this **only when the user asks you to add a Skill**, never on your own initiative, not even when a skill would help with the task:

```sh
agentsync skills add <owner/repo | https://github.com/owner/repo> [names…] --json
```

Without names it asks for every skill in the repository (at most 20); with names, only those. It doesn't add anything itself: it prints a link (`request.url`) where the user approves the request in the browser, choosing which skills to add and their Machines. Show the user that link. The command waits up to 10 minutes, then installs on this Machine only what was approved and reports it in `skills`, like `skills sync`. `--no-wait` returns at once; `--no-sync` skips the install.

- **0**: approved; `added` names the Skills added and `skills` what was installed here.
- **6**: not approved yet (`status: "pending"`). Running the same command again resumes the same request rather than making a new one, and if the user approved it meanwhile, installs what was approved without waiting. So ask the user to approve it, then run it again. A request expires after 24 hours.
- **2**: the repository has no skill of a name given; `error.available` lists the ones it has.
- **1**: the user rejected it (`rejected` in the message), the request expired, GitHub couldn't be read, or 5 requests are already waiting for the user.
- **3**: approved, but a skill folder of that name that AgentSync didn't install blocks it here, as above. The command warns about this when it asks.
