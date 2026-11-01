# Skills

A **Skill** is an agent skill (a folder with a `SKILL.md`) from a public GitHub repository, which you add on the Skills page. AgentSync pins each one to an exact commit and installs it on your Machines with the official [`skills`](https://skills.sh) CLI.

## Adding one

**Add a Skill** searches [skills.sh](https://skills.sh). Pick one to see the version AgentSync would pin, the newest commit that changed its folder on the repository's default branch, and its audits from Gen, Socket and Snyk. A High or Critical verdict is a warning, not a block.

A new Skill goes to every Machine, including ones you register later. Open it to choose Machines instead.

## Installing

Nothing is installed until you run this on the Machine:

```sh
agentsync skills sync
```

It's the only command that installs or removes Skills; running it is your go-ahead. When agent sessions start, the hook only tells you what's waiting, such as "2 Skills to install". `agentsync init` offers to install them on a new Machine (`--skills` or `--no-skills` decides up front). See where each Skill stands with `agentsync skills status`.

Every agent with a Target on the Machine gets every Skill: Claude Code, Codex and pi.

## Your own skills are safe

`skills sync` only changes folders AgentSync installed itself:

- A skill folder of the same name that you wrote, or installed some other way, **blocks** the Skill on that Machine. AgentSync never touches it. Rename or remove your folder, or take the Skill off that Machine.
- A Skill you **edited by hand** is left alone until you run `agentsync skills sync --overwrite`.
- A copy you installed earlier with `npx skills add` that is exactly the pinned version is **adopted** without reinstalling.

## Updates

AgentSync checks each Skill's repository daily. When the folder changed, the Skill shows **Update to …** with the new commit, the files that changed and the audits. **Update** moves the pin; every Machine installs it on its next `skills sync`.

With **Updates: Automatic**, AgentSync moves pins for you, but only to a version all three scanners audited after it was pushed and none rated High or Critical. Anything else waits for you. **Never update automatically** keeps one Skill manual.

Every move of a pin is kept in the Skill's history.

## Found on your Machines

Each Machine reports the skills it has, with names, sources and folder hashes, never file contents. A skill installed from GitHub that isn't a Skill yet shows up with **Add**, which pins the version that Machine already has. Hand-written skills are listed by name only.

When a Machine has a newer version of a Skill than its pin, from the same repository's default branch, **Use everywhere** moves the pin to it.

Removing a Skill takes it off every Machine at its next `agentsync skills sync`, except copies edited by hand. Logging a Machine out, or deleting it here, leaves its installed skills where they are.
