# Skills

A **Skill** is an agent skill (a folder with a `SKILL.md`) from a public GitHub repository, which you add on the Skills page. AgentSync pins each one to an exact commit and installs it on your Machines with the official [`skills`](https://skills.sh) CLI.

## The Skills page

**Synced** lists what AgentSync manages. **On your machines, not synced** lists skills your Machines have that it doesn't manage yet. Both group skills by GitHub repository, and search matches repository and skill names.

**Needs you** appears when a synced Skill has an update or a problem, or a Machine asked for new Skills. A strip at the top appears when a Machine has changes waiting, with the command that installs them.

## Syncing a skill you already have

**Sync** on a skill pins the version that Machine already has and sends it to every Machine, including ones you register later. **Sync** on a repository does this for every listed skill from that repository. Tick some skills to use **Sync selected** instead. When several skills go at once, AgentSync asks first, and shows any High or Critical audits and any skills the repository no longer has. A single skill syncs straight away, with no audit check. Open a Skill to choose its Machines.

**Ignore** hides a skill from the list. The **ignored** link lets you restore it. To take a synced Skill off your Machines, open it and use **Remove from all machines**.

## Adding something new

**Add skills** searches [skills.sh](https://skills.sh). Pick one to see the version AgentSync would pin, the newest commit that changed its folder on the repository's default branch, and its audits from Gen, Socket and Snyk. A High or Critical verdict is a warning, not a block. You can sync that skill or browse its repository.

**Browse all skills in this repo** lists everything in a repository, including skills none of your Machines have. Nothing starts ticked, and new skills in a repository are never synced automatically, so come back here to pick them up. Skills your Machines have sync at the version they have; others use the newest version.

## Asking from a Machine

An agent can't add Skills, but it can ask. When you tell it "add the skills from t3dotgg/tstack", it runs:

```sh
agentsync skills add t3dotgg/tstack
```

Name skills after the repository to ask for just those; otherwise it asks for every skill there, up to 20. AgentSync pins and audits them right away, and the command prints a link to the request. It shows which Machine asked, each skill's commit and audits, and which Machines the Skills go to (all of them, unless you choose). Skills rated High or Critical, or not audited, start unticked. Approve adds exactly the versions shown, even if the repository changed since.

The command waits up to 10 minutes, then installs on its Machine the Skills you approved, and nothing else. If you don't decide in time it exits 6; running it again picks up the same request, or installs what you approved meanwhile. A request expires after 24 hours, and an account can have 5 waiting at once. If the Machine already has a hand-installed skill of the same name, the command warns you, and the new Skill stays blocked there until you move that folder.

## Installing

Nothing is installed until you run this on the Machine:

```sh
agentsync skills sync
```

Apart from `skills add` installing what you just approved, it's the only command that installs or removes Skills; running it is your go-ahead. When agent sessions start, the hook only tells you what's waiting, such as "2 Skills to install". `agentsync init` offers to install them on a new Machine (`--skills` or `--no-skills` decides up front). See where each Skill stands with `agentsync skills status`.

Every agent with a Target on the Machine gets every Skill: every Claude Code instance, Codex, pi, OpenCode and Antigravity.

## Your own skills are safe

`skills sync` only changes folders AgentSync installed itself:

- A skill folder of the same name that you wrote, or installed some other way (from another repository, say), **blocks** the Skill on that Machine, in either agent's skills directory. AgentSync never touches it, not even with `--overwrite`. Rename or remove your folder, or take the Skill off that Machine.
- A Skill you **edited by hand** is left alone until you run `agentsync skills sync --overwrite`, which replaces it with the pinned version, or deletes it if the Skill no longer goes to that Machine.
- A copy you installed earlier with `npx skills add` from the same repository, exactly at the pinned version, is **adopted** without reinstalling.

## Updates

AgentSync checks each Skill's repository daily. When the folder changed, the Skill shows **Update to …** with the new commit, the files that changed and the audits. **Update** moves the pin; every Machine installs it on its next `skills sync`.

With **Auto-approve safe updates** on, AgentSync moves pins for you, but only to a version all three scanners audited after it was pushed and none rated High or Critical. Anything else waits for you. Either way, Machines still install it only on their next `skills sync`. **Never auto-approve updates** keeps one Skill manual.

Every move of a pin is kept in the Skill's history.

## Found on your Machines

Each Machine reports the skills it has, with names, sources and folder hashes, never file contents. A skill installed from GitHub that isn't a Skill yet shows up with **Sync**. Hand-written skills are listed by name only, because they can't be synced.

When a Machine has a newer version of a Skill than its pin, from the same repository's default branch, **Use everywhere** moves the pin to it.

Removing a Skill takes it off every Machine at its next `agentsync skills sync`, except copies edited by hand. Logging a Machine out, or deleting it here, leaves its installed skills where they are.
