# AgentSync CLI UX improvement plan

Date: 2026-10-25. Status: proposal; no CLI implementation changes.

## Recommendation

Make the everyday CLI compact and easy to scan: semantic color, arrow-key choices with complete labels, details on request, and one progress indicator during waits. Use `@clack/prompts` for interactive controls, `picocolors` for ordinary output, and `ora` for progress. Keep the existing parser, commands, and sync logic.

Ship the output foundation and replacement prompts first. Then improve setup and help. A persistent full-screen application would add complexity without helping the short operations AgentSync performs.

The supporting [research note](research/cli-ux.md) compares libraries and records primary sources. The recommendations and thresholds below are design decisions for AgentSync, rather than claims that one standard mandates a particular appearance.

## What the current CLI does

| Finding | Evidence | Consequence |
| --- | --- | --- |
| `choose()` accepts a full word or its first letter and retries indefinitely. | [handoff.ts](../packages/cli/src/handoff.ts) | People must read bracketed shortcuts, type an answer, and press Enter. No typed cancellation contract exists. |
| Drift prints the complete diff before asking; a noninteractive unresolved Drift also prints it. | [sync.ts](../packages/cli/src/commands/sync.ts) | Large changes bury the decision and next action. |
| Successful sync can print nothing when all Targets are current. | [sync.ts](../packages/cli/src/commands/sync.ts) | A person gets no positive confirmation. |
| Setup prints individual installation details and polls registration without progress feedback. | [init.ts](../packages/cli/src/commands/init.ts) | Noisy setup surrounds an apparently idle wait. |
| All help requests use one long `HELP` string; no command-specific help exists. | [cli.ts](../packages/cli/src/cli.ts) | `agentsync sync --help` prints every command and setup flag. Confirmed by running both help commands from the existing build. |
| `Io` exposes a single `interactive` boolean and line-oriented `ask()`. | [io.ts](../packages/cli/src/io.ts), [index.ts](../packages/cli/src/index.ts) | It cannot independently describe stream color, animation, terminal width, or structured choices. |
| `Context.say()` mixes progress and results on stdout in human mode. | [context.ts](../packages/cli/src/context.ts) | Adding a spinner directly to existing messages would mix transient rendering with final output. |
| Commands already return data for JSON; hooks have their own output; tests inject I/O and a fake server. | [cli.ts](../packages/cli/src/cli.ts), [harness.ts](../packages/cli/tests/harness.ts) | There is a good seam for incremental changes. A framework rewrite is unnecessary. |

## Experience rules

1. **Outcome first.** A normal sync ends with one sentence naming the revision and counts. Print warnings and incomplete work even in compact output.
2. **Details are available deliberately.** Add `--verbose` for per-file installation details and complete diffs. Interactive Drift offers “Review changes” without leaving the decision flow. Do not shorten commands whose purpose is printing content (`template`, `conflict get`, `vars`).
3. **Choices explain consequences.** Use labels such as “Keep the hand edit and skip this Target” and “Replace with the Template; keep a backup.” Default to the non-destructive choice. Arrow keys move; Enter selects; Space toggles a multiselect; show the relevant hint.
4. **Color conveys state.** One cyan accent for selection, green for success, yellow for Drift or attention, red for failures. Keep normal text in terminal defaults. Pair every state with words; essential information must remain readable without color or Unicode. Use bold sparingly, and avoid dimming instructions or error recovery text.
5. **Motion explains waiting.** One spinner for network work or browser approval. Start it only after roughly 150 ms to avoid flashes; do not delay completed operations to display it. No typewriter text, splash animation, or invented percentages.
6. **Finish cleanly.** Stop progress and restore input/cursor state before a prompt, editor, agent handoff, or exit. Keep the transcript in normal terminal scrollback.

Concise success output and progressive detail follow the [CLI Guidelines](https://clig.dev/#output). Clack supplies selection controls and progress helpers with custom streams and cancellation detection; the application still owns its behavior. See [Clack's API](https://bomb.sh/docs/clack/packages/prompts/).

## Proposed flows

These transcripts specify content and hierarchy; the renderer supplies color. Values are illustrative.

### Everyday sync

```text
$ agentsync sync
✓ Synced Template revision 42 · 1 Target updated, 1 already current
```

An unchanged run says `✓ All 2 Targets are up to date · Template revision 42`.
Partial success explicitly counts updated, skipped, and failed Targets and names every failure. A handed-off or kept Target must not be reported as successfully synced. Preserve the existing `--keep` exit behavior while saying it was skipped.

### Drift

```text
! Drift in ~/.codex/AGENTS.md
  This Target was edited by hand. What should happen?

  › Keep the hand edit and skip this Target
    Review changes
    Ask an agent to update the Template
    Replace with the Template; keep a backup

  ↑↓ Move · Enter Select · Ctrl+C Cancel
```

“Review changes” shows the full diff on request and returns to this menu. Initially use ordinary terminal scrollback; a pager can follow if large-diff use warrants it. Never silently truncate the requested diff. Show the actual backup path after replacement. Explicit `sync --overwrite` keeps its current behavior without an additional confirmation prompt.

Replace every `choose()` call, including Conflict resolution, editor retry/discard, and agent selection. Use stable internal values separate from labels. Do not default the editor retry menu to discard. Keep the remembered handoff agent; improve its initial picker rather than asking again on each use.

Noninteractive unresolved Drift prints the path, a short explanation, and the `--keep` / `--overwrite` recovery commands; full diffs remain in JSON and `--verbose`. It still exits 3 and preserves the hand edit.

### Setup

```text
$ agentsync init --server https://<your-server>
AgentSync setup

Open: <verification URL from the server>
Code: <user code>
⠋ Waiting for browser approval…

✓ Registered Machine krejzac-server
✓ Ready · 2 Targets synced · hooks and skill installed
! Codex: open /hooks and trust the new hook
```

The URL and code stay visible while waiting. Present missing Variables as labeled text inputs with “leave unset” explained. Group installation details under `--verbose`, but always show skipped installations, missing Variables, and the Codex trust step.

After the basic redesign, offer an interactive multiselect for detected agents only when no `--agent` or `--target` was provided. Preselect detected agents; flags remain authoritative. Keep noninteractive detection, the largest-file first import, `--no-wait`, resumed registration, `--no-hooks`, and `--no-skill` behavior. Choosing the import source is a separate behavioral feature and need not block this work.

### Status, errors, and help

`status` starts with the Machine and revision, followed by one row per Target: agent, path, and a word such as “Current,” “Out of date,” or “Drift.” Use vertical rows on narrow terminals rather than overflowing a wide table. Server and extra metadata belong under `--verbose`; open Conflicts and their real URLs stay visible.

Expected errors show the problem, affected path or server when useful, and one next action. Keep detailed diagnostics out of normal output. Deduplicate repeated missing-Variable and installation warnings.

Root help lists commands with one-line descriptions and a few common flags. `agentsync <command> --help` and `agentsync help <command>` show that command's syntax, options, and examples; support nested Conflict help. Do not introduce an interactive home menu in the initial release. Bare invocation keeps its existing help/usage behavior, with a shorter page.

## Library decision

| Option | Decision for this repo |
| --- | --- |
| `@clack/prompts` 1.8.1 | Preferred for consistent select/text/confirm controls. Wrap it in the terminal adapter; verify stderr, monochrome, cancellation, and Node 22.12 behavior. Do not use its bundled spinner in this implementation. |
| `picocolors` 1.1.1 | Preferred for the small semantic palette. Use explicit `createColors(enabled)` instances per stream; its automatic detection does not implement all of our desired environment rules. |
| `ora` 9.4.1 | Preferred for progress. Set stderr explicitly, use `discardStdin: false`, and have the application own abort/cleanup. Gate creation entirely in machine/plain modes. |
| `@inquirer/prompts` | Credible alternative if Clack's prompt adapter fails acceptance. Latest excludes the current Node minimum; an older compatible major needs a deliberate maintenance decision. Do not install both prompt libraries. |
| Node `util.styleText` / Chalk | Alternatives. The built-in exists at the current floor, but its Node 22.12 array-style path bypasses color validation. Chalk offers richer styling than this palette needs. |
| Ink / a complete TUI framework | Defer. React rendering is useful for persistent interactive applications, while these commands mostly fetch, ask, and exit. |
| Commander / another parser | Keep `util.parseArgs`. Add command help metadata without changing the parser as part of the visual work. |

Source inspection changes the initial dependency-free styling idea: the [Node 22.12 implementation](https://github.com/nodejs/node/blob/v22.12.0/lib/util.js#L231) returns array-formatted text before checking color capability. Clack also uses native styling internally without consistently passing its destination stream, so adding picocolors for our own output does not by itself fix Clack's rendering. The prompt adapter must enforce monochrome/mixed-stream behavior and pass acceptance tests. See the [research findings](research/cli-ux.md) for the published-source details.

Clack's spinner invokes an input-blocking helper that can exit the process directly on Ctrl+C. Since AgentSync must persist completed writes and retain drafts, the implementation plan chooses ora despite the extra package. Configure it explicitly rather than inheriting its stdin ownership defaults. Sources: [Clack spinner](https://github.com/bombshell-dev/clack/blob/1835f415776dda400cfece4365ec66380be12f71/packages/prompts/src/spinner.ts), [ora controls](https://github.com/sindresorhus/ora#isenabled). Ink describes its [React-based approach](https://github.com/vadimdemedes/ink).

Compatibility check from npm metadata on the research date: [`@clack/prompts` 1.8.1](https://registry.npmjs.org/@clack%2fprompts/1.8.1) declares Node `>=20.12.0`, which includes this repo's minimum. [`@inquirer/prompts` 8.7.4](https://registry.npmjs.org/@inquirer%2fprompts/8.7.4) declares `>=23.5.0 || ^22.13.0 || ^20.17.0`, which excludes Node 22.12. Do not adopt the latest Inquirer fallback without either verifying an older compatible release or explicitly deciding to raise the repo minimum. Engine declarations are a first filter; acceptance still requires testing the actual resolved dependency tree.

## Output and automation contract

Compute prompt eligibility, color capability, and animation capability separately. Add `--verbose`, `--no-color`, and `--no-progress`, plus `--plain` for a complete static, accessible presentation path. The latter also changes prompt rendering; merely disabling color and progress would leave cursor-based widgets.

| Invocation | Required behavior |
| --- | --- |
| Human at a capable terminal | Compact styled results; arrow-key prompts; progress on stderr. |
| `--verbose` | Add detailed paths, installation steps, and complete diffs. Does not enable prompts in other modes. |
| `--no-color` or nonempty `NO_COLOR` | No added color on either stream. This is independent of animation. |
| `--no-progress` | No animated progress or progress redraws; retain final outcomes and actionable warnings. Interactive choice widgets remain available. |
| `--plain` | No decoration, Unicode status glyphs, boxes, or cursor rewriting. At a terminal, offer complete numbered choices and ordinary text inputs; Enter chooses the safe default. It remains interactive unless another mode forbids questions. |
| `TERM=dumb` | Plain static output; no cursor-based prompt widgets. Require flags for decisions. |
| Pipe, redirected stream, or CI | Plain static output on redirected streams; no prompts or animation for the invocation. Never wait for answers. |
| `--yes` | Never prompt; retain existing flags/defaults. It does not authorize overwriting Drift. Use static progress behavior. |
| `--json` | One JSON document on stdout; preserve fields, full diffs, and exit codes. No decoration, prompts, or animation on either stream. Keep actionable diagnostics on stderr; omit redundant human narration. |
| `sync --hook <agent>` | Preserve the dedicated path: at most one plain `AgentSync: …` line, no interactive UI, existing ~2-second network limit, always exit 0. |
| `template` / `conflict get` without `--out` | Preserve content-only stdout, including current newline behavior. No headers, colors, summaries, or content truncation. |
| `vars` listing | Preserve `KEY=VALUE` output; do not add decorative headings. |

For initial rollout, require stdin, stdout, and stderr to be TTYs before enabling prompts; also exclude CI, `--yes`, JSON, hook mode, and dumb terminals. Check each destination stream separately for color. Make `--no-color` and nonempty `NO_COLOR` authoritative even if a dependency would otherwise force color. Follow the [NO_COLOR convention](https://no-color.org/) and test the application's policy rather than relying on library defaults.

Transient progress and prompts go to stderr. Final human results and list output go to stdout; warnings and failures go to stderr. Keep device approval instructions on stderr in JSON mode so `init --json` remains usable while waiting. Do not turn stderr into a stream of implementation logs.

Useful precedent: GitHub CLI exposes separate controls for prompts, accessible prompting, and spinner animation, rather than treating color as a proxy for every terminal capability. Its accessible prompter is marked preview; it is a reason to test our experience, not evidence that a chosen library is automatically accessible. See the [GitHub CLI environment reference](https://cli.github.com/manual/gh_help_environment).

Cancellation needs an explicit path: normalize a cancelled prompt/SIGINT, restore terminal state, and return conventional exit 130 for a user interruption. Preserve existing codes 0–5 for their current meanings; document 130 separately. Do not classify cancellation as a network timeout or a per-Target write error. `applySync` must rethrow cancellation through its broad catch and still save completed writes in its `finally` block. Cancellation can occur after earlier writes; report that honestly. In `withDraft`, retain unsaved drafts on interruption and show recovery; only an explicit “Discard edit” choice should delete an unsaved draft. Keep hooks exempt from the new interactive cancellation behavior.

## Implementation sequence

Effort is relative: S is a localized change; M touches several commands or lifecycle boundaries. These are planning estimates, not delivery commitments.

| Phase | Work and files | Completion criteria | Effort |
| --- | --- | --- | --- |
| 1. Output foundation | Add terminal adapter and semantic output helpers beside `io.ts`; extend `Io` capabilities; update `index.ts`, `context.ts`, `cli.ts`, and harness. Add display flags, including the plain path. Implement compact sync/status summaries without changing operations. | Default healthy sync is 1–3 final lines; warnings remain visible; JSON/raw content/hooks unchanged; colors respect stream and user settings. | M |
| 2. Real choices | Add typed `select`, `text`, and cancellation to the adapter; remove `choose()` and custom readline setup. Update `handoff.ts`, `sync.ts`, `edit.ts`, and `init.ts`. Move diffs behind review/verbose. Handle cancellation in `exit.ts` and `drafts.ts`. | Every existing choice uses arrows and labels; Enter defaults safely; review returns to the decision; interruption preserves edits and completed-write bookkeeping; no repeated letter prompts. | M |
| 3. Waiting and setup | Add delayed, scoped progress around network requests and registration polling. Consolidate setup output in `init.ts`; stop progress before all external interactions. Add agent multiselect after the core flow is stable. | Browser code remains visible; only one renderer owns the terminal; `--no-wait` remains immediately usable; errors and interruption always restore the cursor. | M |
| 4. Help and consistency | Command-scoped help metadata in `cli.ts`; consistent errors and remaining command results; update CLI README and document new display flags/exit 130. | Root help fits approximately one 80×24 screen; command help contains relevant options and examples; narrow-terminal output remains readable. | S–M |

Keep the design small: an I/O adapter for terminal effects plus a few shared formatting functions. Commands own decisions and return their existing data. Avoid a new event bus, global process exits inside helpers, and a parallel command framework. Lazy-load interactive UI where practical so hook invocations do not pay its startup cost. One operation owns progress at a time; use `try/finally` for cleanup. Implement the 150 ms spinner start threshold in the wrapper; a library's frame interval is a different setting. Use one AbortController for each command's cancellable work so stopping the spinner also stops outstanding network/polling work rather than letting it continue silently.

## Verification before shipping

- Extend the current fake-I/O harness with typed option values and independent terminal capabilities. Keep assertions about outcomes, files, exit codes, and recoverability; do not assert every ANSI sequence or spinner frame.
- Run existing CLI tests and typechecks. Add focused coverage for safe defaults, `--yes` with unresolved Drift, JSON with full diffs and no decoration, unchanged raw content, and the existing hook contract.
- Exercise cancellation before and after a Target write, during an invalid draft retry, and during browser approval. Check config bookkeeping, retained drafts, pending-login resumability, and terminal cleanup. Verify prompt cancellation is not swallowed by the per-Target error handler.
- Use a real pseudo-terminal for a small integration smoke test: Down/Enter selects the expected action, Ctrl+C exits promptly, and cursor/input are restored after an editor or agent handoff. Pure mocked answers cannot verify arrow-key handling.
- Manually check an ordinary terminal, SSH/Tailscale terminal, CI/piped output, `TERM=dumb`, `NO_COLOR`, `--no-color`, `--no-progress`, narrow width (40 columns), and light/dark terminal themes. Check a long Target path and a large requested diff.
- Run the compatibility smoke check on Node 22.12 and the supported current Node version. Measure hook startup before/after; ensure the UI dependency is not initialized during hooks. Avoid claiming accessibility until keyboard-only and screen-reader behavior have been tried.

Start with phases 1 and 2: they directly address the reported noise and typed-letter UX. Phases 3 and 4 complete the polish without requiring a new CLI architecture.

Validation performed for this proposal: source and existing test review, plus read-only root and command help invocations. No dependencies were installed and no runtime UI was implemented. The shell currently resolves Node 18.20.4, so those help invocations do not establish compatibility with the package's supported Node range; the Node 22.12 checks above remain implementation acceptance work.
