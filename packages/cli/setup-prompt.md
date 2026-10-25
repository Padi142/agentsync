Set up AgentSync on this computer. AgentSync keeps my Global Instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) in sync across my computers: one Template on the server at <SERVER_URL> is Rendered into each of those files. Run every `agentsync` command below with `--json`, read its JSON output, and branch on its exit code.

1. Check that `node --version` is 22.12 or later, then install the CLI with `npm install -g agentsync`.
2. Run `agentsync init --yes --json --no-wait --server <SERVER_URL>`. Show me `verificationUri` and `userCode`, ask me to open the link and approve the code, and wait until I say I have.
3. If more than one of `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` exists with different content, ask me which one should become the Template in case this is my first computer. Pass it as `--import <path>` in the next step. Without it, AgentSync imports the largest file.
4. Run `agentsync init --yes --json` (plus `--import <path>` from step 3). It finishes registering this computer, installs the SessionStart hooks and the `agentsync` skill, and writes the Rendered Template into each file.
   - Exit 5: the code expired or was denied. Go back to step 2.
   - Exit 3: a file differs from the Template (Drift). For each entry in `targets` with `status: "drift"`, show me its `diff` and ask whether to keep that text for all my computers, discard it, or leave the file alone for now. To carry out each answer, read the skill file `init` just installed (the first path in `skills`) and follow its "Fold Drift into the Template" section.
5. If `missingVariables` is not empty, ask me for a value for each, save them with `agentsync vars --json --var NAME=VALUE`, and run `agentsync sync --json`.
6. If `hooks` lists `~/.codex/hooks.json`, tell me to open Codex once and run `/hooks` to trust the AgentSync hook.
7. Tell me what was set up: this computer's name, which files AgentSync now writes, which file was imported (if any), and that a new or changed Template applies from my next agent session.
