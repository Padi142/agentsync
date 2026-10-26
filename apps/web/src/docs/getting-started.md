# Getting started

AgentSync keeps your global agent instructions, such as `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and `~/.pi/agent/AGENTS.md`, the same on every computer you work on. You write one **Template** here. Each **Machine** fills in its own details and writes the result into its agents' files.

## How it works

1. You keep one Template on this server. It's Markdown, plus a few Expressions like `{{machine.nickname}}` for the parts that differ per computer.
2. You register each computer as a Machine with the `agentsync` CLI. It finds Claude Code, Codex and pi, and installs a small hook for each.
3. When an agent session starts, the hook fetches the Template, fills it in for that Machine, and writes the file. If the server can't be reached, the existing file stays.

## Add your first Machine

The CLI isn't published to npm yet, so for now you build it from the repository. You need Node.js 22.12 or later, [pnpm](https://pnpm.io/installation) and git. On the computer you want to add, run:

```sh
git clone https://github.com/Padi142/agentsync.git ~/agentsync
cd ~/agentsync
pnpm install && pnpm build
(cd packages/cli && npm link)
```

`npm link` puts the `agentsync` command on your PATH. If npm's global folder needs root on your system, run it with `sudo`. Keep the `~/agentsync` folder: the hooks run the CLI from it. To update the CLI later, run `git pull && pnpm install && pnpm build` there.

Then register the computer:

```sh
agentsync init --server <SERVER_URL>
```

`init` prints a sign-in link. Open it, approve the code, and it finishes on its own. On your first Machine, the existing instruction file becomes your Template, so nothing you already wrote is lost.

You can also let your agent do it: [Add a Machine](/setup) has a prompt to paste into Claude Code, Codex or pi.

If you use Codex, open it once and run `/hooks` to trust the new hook. Codex skips hooks it hasn't been told to trust.

## Edit your instructions

Open the [Template editor](/). The preview on the right shows exactly what each Machine writes, for each agent. Text that comes from a Variable is underlined in violet, so you can see what changes from one computer to the next.

You can also edit from a terminal:

```sh
agentsync edit
```

## When changes arrive

A saved Template reaches a Machine the next time an agent session starts there. Claude Code and Codex read their instructions before the hook runs, so a change applies **from the session after that**. pi waits for the hook, so a new pi session has it straight away. To update a Machine right away, run:

```sh
agentsync sync
```
