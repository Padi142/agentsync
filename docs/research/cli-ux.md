# AgentSync CLI UX research

Research date: **2026-10-25 (UTC)**. Scope: research and recommendations only; no implementation or dependency changes.

## Recommendation

Keep `node:util.parseArgs`, the command handlers, existing JSON results, hook contract, and injectable I/O. Adopt **`@clack/prompts` 1.8.1 for interactive choices and `picocolors` 1.1.1 for AgentSync-owned text**, behind a small presentation adapter. Start with concise static progress; use Clack's spinner only after its input ownership and cancellation behavior meet the acceptance criteria below. Do not introduce Ink or a new command framework for this scope.

This recommendation prioritizes a coherent interactive experience while retaining the declared Node **>=22.12** floor. Clack's published engine range includes that version; latest Inquirer's does not. Clack can replace individual prompts without adopting its intro/outro/logging helpers everywhere. These are design judgments based on the package capabilities and compatibility findings below, not claims that one library is universally superior.

The final [implementation plan](../cli-ux-plan.md) selects **ora 9.4.1 for progress** alongside Clack and picocolors. It favors ora's explicit stdin control over the smaller bundled-spinner option, because the Clack input-blocking cancellation caveat below could bypass AgentSync's cleanup. Follow that plan for the chosen stack and delivery phases; this note records the alternatives and evidence.

For an incremental CLI that prioritizes precise prompt/spinner control over a unified visual style, **Inquirer + picocolors + optional ora is a credible alternative**. Use verified Inquirer 7.10.1 at the existing floor, or explicitly raise the floor to at least Node 22.13 before adopting current Inquirer 8.7.4. An older major entails its own maintenance tradeoff; do not silently install latest and assume Node 22.12 support.

## Existing boundaries to preserve

The local source establishes a good starting point:

- [`packages/cli/package.json`](../../packages/cli/package.json) declares TypeScript-built ESM and Node `>=22.12`; the root uses pnpm.
- [`cli.ts`](../../packages/cli/src/cli.ts) uses `parseArgs`, exposes `--json` and `--yes`, and emits one final JSON document after command execution. [`exit.ts`](../../packages/cli/src/exit.ts) reserves exits 0–5 for success, error, usage, Drift, Conflict, and auth.
- [`context.ts`](../../packages/cli/src/context.ts) already disables questions for JSON, `--yes`, and hooks. Its `say()` sends normal human output to stdout and JSON progress to stderr.
- [`index.ts`](../../packages/cli/src/index.ts) currently defines interactivity using stdin and stdout TTYs and creates readline questions on stdout. [`handoff.ts`](../../packages/cli/src/handoff.ts) implements letter/name choices with a retry loop.
- [`README.md`](../../packages/cli/README.md) documents hook output as at most one context-bearing line, exit 0, no prompts, and a two-second server budget. It also explains `init --no-wait` for agents whose shell output arrives only after command completion.

Presentation work should preserve these behaviors intentionally. In particular, hook stdout is useful data for the calling agent and must remain outside normal interactive rendering.

## Verified package versions and compatibility

The table records the npm registry's **`latest` dist-tag observed on the research date**, not a prediction about future versions. Engine ranges and module formats came from publisher-supplied registry metadata; source inspection used the corresponding published tarballs. This is declared compatibility, not a runtime certification of the complete transitive dependency graph on Node 22.12.

| Package | Verified latest | Published Node engine | Module / implication for AgentSync |
| --- | --- | --- | --- |
| `@clack/prompts` | **1.8.1** | `>=20.12.0` | ESM; current floor is included. Includes prompts, logs, grouping, and progress helpers. [Metadata](https://registry.npmjs.org/@clack%2fprompts/1.8.1) |
| `@inquirer/prompts` | **8.7.4** | `>=23.5.0 \|\| ^22.13.0 \|\| ^20.17.0` | ESM; **Node 22.12 is excluded**, even though some Node 20 versions are supported. [Metadata](https://registry.npmjs.org/@inquirer%2fprompts/8.7.4) |
| `picocolors` | **1.1.1** | No `engines` field | CommonJS with TypeScript declarations; no dependencies declared. Can be consumed from Node ESM. Absence of an engine field is not a formal Node support promise. [Metadata](https://registry.npmjs.org/picocolors/1.1.1), [Node ESM interoperability](https://nodejs.org/docs/latest-v22.x/api/esm.html#interoperability-with-commonjs) |
| `chalk` | **6.0.1** | `>=22` | ESM; no dependencies declared in this release. Compatible engine range, richer styling API. [Metadata](https://registry.npmjs.org/chalk/6.0.1) |
| `ora` | **9.4.1** | `>=20` | ESM; compatible engine range, but adds its own dependency graph, including Chalk 5. [Metadata](https://registry.npmjs.org/ora/9.4.1) |
| `ink` | **8.0.0** | `>=22` | ESM; engine includes the floor, but requires React `>=19.3.0` as a peer and adds a React reconciler/layout stack. [Metadata](https://registry.npmjs.org/ink/8.0.0) |

An alternative checked explicitly: **`@inquirer/prompts` 7.10.1** declares Node `>=18` and ESM. Its referenced select 4.4.2, checkbox 4.3.2, and confirm 5.1.21 packages also declare `>=18`. This is a verified older-major option, not the current latest. [Prompts metadata](https://registry.npmjs.org/@inquirer%2fprompts/7.10.1), [select](https://registry.npmjs.org/@inquirer%2fselect/4.4.2), [checkbox](https://registry.npmjs.org/@inquirer%2fcheckbox/4.3.2), [confirm](https://registry.npmjs.org/@inquirer%2fconfirm/5.1.21).

## Findings and proposed behavior

### 1. Progressive disclosure and concise output

Clack's official guidance recommends conditional questions, defaults, and progressive disclosure. `uv` distinguishes concise command help from detailed command documentation and offers verbosity/progress controls. These precedents support an outcome-first default rather than displaying every operation. [Clack best practices](https://bomb.sh/docs/clack/guides/best-practices/), [uv CLI reference](https://docs.astral.sh/uv/reference/cli/).

Recommended AgentSync policy:

- Top-level help lists commands, one-line purposes, and global flags. `agentsync sync --help` shows sync options, examples, and relevant exits. Current parsing returns the same global help for every command; command-specific help can be added without replacing the parser.
- Routine sync ends with one summary, such as `Synced revision 12 · 2 updated · 1 unchanged`. Show target rows when there is something to act on; expose complete per-target detail through `--verbose` and existing JSON. Keep `-v` as the existing version alias; do not repurpose it for verbosity.
- `init` groups the visible work into registration, targets, and completion. Emit a short completion summary plus concrete next steps, including Codex hook trust when applicable. Internal polling attempts and unchanged installations do not need individual lines.
- Drift output first identifies the target, explains the consequence, and offers `Keep hand edit`, `Ask an agent`, and `Overwrite from Template (backup kept)`. Keep the diff available through an explicit view choice or verbose output; do not silently remove useful diagnostics from automation results.
- Errors state the failed operation and actionable recovery. Partial success must name what remains unresolved. Never report a general success line solely because the command reached its end.

These are proposed product behaviors. No transcript length or spinner delay is established as a universal standard by the cited documentation.

### 2. Color, TTYs, and streams are separate capabilities

Node exposes TTY detection on individual streams; redirecting stdout changes its TTY status without necessarily changing stderr. `NO_COLOR` specifies that a **present, nonempty** value disables default color; explicit per-invocation settings may override that preference. Color suppression alone does not disable cursor movement or animation. [Node TTY documentation at 22.12](https://github.com/nodejs/node/blob/v22.12.0/doc/api/tty.md), [NO_COLOR specification](https://no-color.org/).

Recommended policy:

1. Decide prompt eligibility, motion, and color separately. Require terminal stdin and the chosen prompt output stream, plus no CI/noninteractive policy, JSON, `--yes`, or hook mode, before asking a rich question.
2. Compute color for **the destination stream**, independently for stdout and stderr. Default redirected streams and `TERM=dumb` to plain output. Keep JSON and hook text free of presentation escapes regardless of force-color settings.
3. If exposing `--color=auto|always|never`, document precedence: machine modes always stay plain; explicit color setting wins for human text; otherwise nonempty `NO_COLOR` disables color; then interpret `FORCE_COLOR`; finally auto-detect the destination. Treat `FORCE_COLOR=0` as disabled. Define conflicting environment variables deliberately rather than inheriting accidental library precedence.
4. Use a small semantic palette: headings, success, warning, and error. Always include words such as `Drift`, `Conflict`, or `Error`; never encode state only in hue. Keep paths and commands legible without dim text.

**Library traps verified in source:** picocolors 1.1.1's automatic detection consults stdout, treats nonempty `CI` as color-enabling, and treats `FORCE_COLOR` as a truthy string—so `FORCE_COLOR=0` is not parsed as a numeric off switch. Use separate `createColors(enabled)` instances controlled by AgentSync instead of its singleton defaults. Chalk provides `chalkStderr` and configurable color levels, but its checked vendored detection source does not itself check `NO_COLOR`; the application still needs a consistent policy. Both checked releases declare zero dependencies, so the comparison should be API/scope rather than an outdated claim that Chalk necessarily adds dependencies. [Picocolors 1.1.1 source](https://github.com/alexeyraspopov/picocolors/blob/v1.1.1/picocolors.js), [Chalk 6 source](https://github.com/chalk/chalk/blob/47fc05abd46171b235e24174cd2dba83d25bf037/source/index.js), [Chalk color detection](https://github.com/chalk/chalk/blob/47fc05abd46171b235e24174cd2dba83d25bf037/source/vendor/supports-color/index.js).

Node's built-in `util.styleText` is another zero-package option and accepts an explicit stream at this floor. However, the Node 22.12 implementation's array-format branch returns before its color-capability check. A native implementation should gate formatting itself and verify the floor rather than assuming all newer Node behavior exists there. [Node 22.12 implementation](https://github.com/nodejs/node/blob/v22.12.0/lib/util.js#L231).

### 3. Prompts: arrows, multiple selections, confirmation, and cancellation

Both libraries provide single selection, multiple selection, confirmation, and text input. Clack exposes `select`, `multiselect`, and `confirm`; Inquirer uses `select`, `checkbox`, and `confirm`, with separately installable prompt packages. Both accept custom streams and AbortSignals. [Clack prompt API](https://bomb.sh/docs/clack/packages/prompts/), [Inquirer prompt API](https://github.com/SBoudrias/Inquirer.js/tree/ea3130ebc609a6a3910b5397244044de7eda3d05/packages/prompts), [Inquirer select](https://github.com/SBoudrias/Inquirer.js/tree/ea3130ebc609a6a3910b5397244044de7eda3d05/packages/select), [Inquirer checkbox](https://github.com/SBoudrias/Inquirer.js/tree/ea3130ebc609a6a3910b5397244044de7eda3d05/packages/checkbox).

Recommended interactions:

- Single choice: Up/Down, Enter; labels describe effects, not just short command tokens. Keep option sets small.
- Multiple choice: Up/Down moves, Space toggles, Enter submits. Display that instruction, show selected items textually, and validate required selection. Use this only when users actually need a subset of detected agents; do not add a question when flags or an established default already answer it.
- Confirmation: default to the action that preserves existing instructions. Reserve a direct yes/no confirmation for a genuine binary decision; Drift is naturally a named choice.
- Cancellation: normalize library cancellation at the presentation boundary, abort pending work, restore the cursor/raw mode, and print one short message without a stack. Clack returns a cancellation symbol checked by `isCancel`; Inquirer rejects with `ExitPromptError` for forced prompt closure and `AbortPromptError` for AbortSignal cancellation. Do not turn cancellation into an answer/default. [Clack cancellation guidance](https://github.com/bombshell-dev/clack/blob/1835f415776dda400cfece4365ec66380be12f71/packages/prompts/README.md#cancellation), [Inquirer cancellation/cleanup guidance](https://github.com/SBoudrias/Inquirer.js/tree/ea3130ebc609a6a3910b5397244044de7eda3d05/packages/prompts#canceling-prompt).

Clack's checked default key aliases include Escape and Ctrl+C as cancel. Do not assume Inquirer Escape has the same global meaning: explicitly specify and verify Escape behavior if promised. Recommend Ctrl+C exit **130** as an additional documented cancellation result; retain meanings 0–5. This is a proposed contract extension. Node documents the Unix signal exit convention and the effect of installing signal handlers. [Clack key settings](https://github.com/bombshell-dev/clack/blob/1835f415776dda400cfece4365ec66380be12f71/packages/core/src/utils/settings.ts), [Node signal events](https://nodejs.org/docs/latest-v22.x/api/process.html#signal-events).

An AgentSync-specific integration concern: the per-target catch in [`applySync`](../../packages/cli/src/commands/sync.ts) currently converts arbitrary thrown errors into target failures and continues. A future normalized cancellation must propagate past that catch while retaining the existing `finally` save of already completed writes. Cancellation after partial progress must not claim rollback or “nothing changed.”

### 4. Restrained progress and stdout/stderr ownership

Reserve stdout for command results, raw Template/Conflict content, or the one JSON document. Use stderr for prompts, transient progress, warnings, and explanatory diagnostics. Hook mode retains its intentional stdout exception. This separation follows the stream controls offered by both prompt libraries and ora's stderr default; it is an application policy, not something a library enforces automatically. [Inquirer stream context](https://github.com/SBoudrias/Inquirer.js/tree/ea3130ebc609a6a3910b5397244044de7eda3d05/packages/prompts#advanced-usage), [ora stream/options](https://github.com/sindresorhus/ora/tree/79cd8c15ac34572cffb3ab53e3d4b6bab6d59ea8#stream).

Recommended motion budget:

- Show a spinner for an actual asynchronous wait, such as fetching server state or waiting for browser authorization. Print the authorization URL/code on stable lines before starting it.
- Delay spinner creation about **200 ms** as a starting design choice so fast work produces no flicker. Clack's spinner `delay` configures frame cadence, not this initial threshold; the application owns the threshold.
- Use one spinner at a time. Stop it before a prompt, diff, editor, or agent handoff, and always stop it in cleanup. Do not animate each local file write or every auth poll.
- Disable motion for JSON, hooks, non-TTY output, CI, and an explicit plain/no-progress preference. Use sparse static progress when it conveys useful state. Never hide required login instructions as part of suppressing progress.

**Clack caveats:** its spinner defaults to stdout, the checked CI helper matches exactly `CI === 'true'`, and its input-blocking helper can directly exit 0 on cancellation. Its prompt renderers also call native `styleText` without the custom output stream, so moving output to stderr does not automatically make color detection follow stderr. Keep application-level gating, test mixed redirection, and do not enable the spinner merely because it is bundled. [Spinner source](https://github.com/bombshell-dev/clack/blob/1835f415776dda400cfece4365ec66380be12f71/packages/prompts/src/spinner.ts), [common rendering source](https://github.com/bombshell-dev/clack/blob/1835f415776dda400cfece4365ec66380be12f71/packages/prompts/src/common.ts), [published core 1.5.1 source archive](https://registry.npmjs.org/@clack/core/-/core-1.5.1.tgz).

**ora caveats:** `isEnabled: false` disables animation but still permits text; `isSilent: true` suppresses everything. Its default `discardStdin: true` takes ownership of terminal input, so an adapter should consider `discardStdin: false`, stop before prompting, and own cancellation explicitly. Never run two renderers against the terminal simultaneously. [ora 9.4.1 options/source](https://github.com/sindresorhus/ora/tree/79cd8c15ac34572cffb3ab53e3d4b6bab6d59ea8#isenabled).

### 5. Accessibility, non-TTY, CI, JSON, and `--yes`

Color-free output is not automatically screen-reader-friendly output. Provide an explicit plain mode that also disables animated redraws, decorative Unicode, cursor rewriting, and boxes. Preserve readable labels, ordinary line-oriented prompts, and flag equivalents for every decision. A human with a screen reader can still be using a TTY; do not equate accessibility with noninteractive execution.

First-party precedent: `gh` exposes accessible prompts, accessible colors, and textual progress through separate environment options, illustrating that these are different concerns. Ink explicitly supports screen-reader rendering and ARIA properties, which matters for a future full TUI, but is not a reason to add React to a sequential CLI. [GitHub CLI environment](https://cli.github.com/manual/gh_help_environment), [Ink accessibility](https://github.com/vadimdemedes/ink/tree/26d2c3f83008142061c22267482489588cc3823c#accessibility).

Clack core 1.5.1 contains an `accessible` setting/`ACCESSIBLE` resolver, but the inspected published prompt rendering paths still use cursor controls and do not substantiate a complete accessible mode. Treat this as insufficient evidence of accessibility, not a guarantee supplied by an option name. Verify actual terminal/screen-reader behavior and retain the application-owned plain path. [Published core source](https://registry.npmjs.org/@clack/core/-/core-1.5.1.tgz), [published prompts 1.8.1 source](https://registry.npmjs.org/@clack/prompts/-/prompts-1.8.1.tgz).

| Execution mode | Questions | Presentation | Result behavior |
| --- | --- | --- | --- |
| Interactive human | Ask only for unresolved choices | Short styled text; optional restrained spinner | Human result on stdout; prompts/progress on stderr |
| Plain/accessibility | Ordinary line-oriented questions if terminal input is available | Static text, explicit labels and keyboard instructions | Same operations and results as rich mode |
| Piped or CI | Never wait for input | Static plain text; no cursor control | Use flags/defaults; fail promptly when required values are missing |
| `--json` | Never prompt or open an editor/agent | No decorative text or spinner; sparse necessary diagnostics on stderr | Exactly one JSON document on stdout for command success/failure |
| `--yes` | Never prompt | Human or JSON output as selected separately | Use documented defaults; never infer overwrite from `--yes` |
| `--hook` | Never prompt | No UI renderer | Existing concise stdout line and fail-open exit 0 |

These are proposed mode semantics, including stricter editor/handoff and CI gating than the current implementation. Detect CI independently of TTY presence and treat explicit `CI=false`/`CI=0` deliberately. Do not identify all agents through guessed environment-variable names: `--json --yes` plus concrete flags is the dependable caller contract.

For Drift, keep the current explicit `--overwrite` versus `--keep` distinction. `--yes` alone should leave unresolved Drift and exit 3, not silently choose destructive behavior. Missing mandatory inputs should produce a usage error with the exact flag needed. External browser authorization remains external even with `--yes`; document `init --no-wait --json --yes` for an agent to receive pending authorization data and resume later.

JSON output must retain semantic exits, per-target outcomes, missing Variables, and Conflict information. Clarify parse-error/help/version exceptions: today argument parsing failures happen before the JSON command-result branch, and help/version return text. Either document these exceptions or deliberately extend the machine contract; do not advertise unconditional JSON for every invocation while leaving this ambiguous. GitHub CLI's explicit JSON formatting options provide a useful precedent for treating machine output as a separate contract. [GitHub CLI formatting](https://cli.github.com/manual/gh_help_formatting).

## Library tradeoffs for this repository

| Choice | What it buys | Cost / limit | Assessment |
| --- | --- | --- | --- |
| Clack + application output adapter | Consistent select/multiselect/confirm, grouped flows, bundled progress helpers | Opinionated appearance; stdout/color and spinner cancellation need explicit handling | Best minimal current-floor starting point; adopt prompts first |
| Inquirer + optional ora | Replace individual readline questions; separately controlled progress; configurable prompt themes and streams | More assembly and dependencies; latest requires a Node floor change | Strong alternative when precise incremental control dominates |
| picocolors | Small basic formatting API and explicit `createColors` factory | Caller must handle per-stream detection, numeric force-color, and application modes | Enough for AgentSync's semantic palette |
| Chalk | Chaining, RGB/256-color styling, separate stderr instance | More API than needed; still requires application color policy | Choose if richer composition is actually used, not for polish alone |
| ora | Focused spinner lifecycle, stderr default, explicit enable/silent controls | Extra package graph and stdin/terminal coordination | Add only if a concrete long wait needs it and Clack's spinner does not fit |
| Ink | React layout/state, persistent views, input handling, accessibility facilities | React/JSX, reconciler, layout and rendering lifecycle | Reserve for a future dashboard/watch view; excessive for current command flows |

Capability sources: [Clack API](https://bomb.sh/docs/clack/packages/prompts/), [Inquirer API](https://github.com/SBoudrias/Inquirer.js/tree/ea3130ebc609a6a3910b5397244044de7eda3d05/packages/prompts), [picocolors source](https://github.com/alexeyraspopov/picocolors/blob/v1.1.1/picocolors.js), [Chalk API/source](https://github.com/chalk/chalk/tree/47fc05abd46171b235e24174cd2dba83d25bf037), [ora API](https://github.com/sindresorhus/ora/tree/79cd8c15ac34572cffb3ab53e3d4b6bab6d59ea8), [Ink API](https://github.com/vadimdemedes/ink/tree/26d2c3f83008142061c22267482489588cc3823c). Dependency and engine claims are grounded in the version table, not bundle-size or speed benchmarks.

## Improvement sequence

1. **Define presentation contracts.** Inventory command result text versus diagnostics; preserve raw content, JSON shapes/exits, and hook behavior. Add explicit stream capabilities to the I/O boundary rather than relying on a single `interactive` boolean. Define color/plain/CI precedence and cancellation before adding renderers.
2. **Improve static output and help.** Add per-command help, concise summaries, clear unresolved-state next steps, and optional detailed output. Keep the existing parser. This produces value before dependency adoption.
3. **Replace choice prompts through an adapter.** Add typed select/multiselect/confirm operations, custom stderr output, validation, and cancellation normalization. Start with Drift and remembered agent handoff. Keep plain prompts available and avoid duplicating terminal/raw-mode ownership with readline.
4. **Polish registration.** Show the durable URL/code first, group the setup transcript, and summarize resulting Machine/Targets/hooks. Preserve pending/resume behavior. Add a single delayed spinner only if its cleanup and cancellation meet the contract; otherwise static “Waiting for authorization” is sufficient.
5. **Verify the terminal and automation matrix.** Use the checks below before declaring the UX work complete. Record tested package versions and exact Node floor in the implementation PR; do not infer correctness solely from `engines`.

### Acceptance checks for a future implementation

- Run on exact Node **22.12.0** and a current supported Node release using the committed pnpm lockfile; verify imports, typechecking, and prompt teardown. If choosing latest Inquirer, update and test the declared floor first.
- Capture stdout and stderr independently for normal output, stdout-only piping, stderr-only redirection, both redirected, `TERM=dumb`, CI with and without a PTY, `CI=1`, and `CI=false`.
- Exercise `NO_COLOR=1`, `NO_COLOR=0`, empty `NO_COLOR`, `FORCE_COLOR=0/1`, and conflicts with explicit color flags. Machine modes must remain escape-free. Necessary information must remain legible with all styling removed.
- Verify arrows/Enter, Space toggling, empty selection, long paths/labels, narrow terminals, and plain-mode input. Test a real screen reader; a snapshot cannot establish accessibility.
- Cancel during each prompt, auth wait, and server request. Check exit status, restored cursor/raw mode, no stack, no extra prompt, and accurate reporting of partial writes. Distinguish user cancellation from server timeout.
- Parse the complete stdout of successful, failed, pending-auth, Drift, and Conflict JSON invocations as exactly one document. Decide and test the documented parse/help/version exceptions. Ensure `--yes`, non-TTY, CI, and JSON paths never hang on input or launch an editor/handoff.
- Verify raw `template` / `conflict get` output retains the existing content/newline behavior and hook output remains at most one useful line with exit 0 and its existing timeout.

No dependency was installed into the project and no runtime integration or accessibility testing was performed during this research. Remaining uncertainty is explicitly concentrated in resolved dependency compatibility, actual assistive-technology behavior, and renderer/cancellation integration—not in the observed registry versions or quoted engine ranges.
