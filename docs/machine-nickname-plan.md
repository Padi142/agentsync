# Machine nicknames, Template editor support, and web deletion

Status: implementation proposal, 2026-10-25. Scope: choose and update Machine nicknames, expose `{{machine.nickname}}` in Templates and editor suggestions, and delete a Machine from the web.

## Design

Use the existing `Machine.name` as the editable nickname. Keep the server-generated UUID as the permanent identity. Nicknames can contain spaces and Unicode, can be duplicated across Machines, and do not change the operating system's hostname. The server remains authoritative; no second local nickname cache is needed.

Use “Machine nickname” in setup/help and “Nickname” on the web form. Make `{{machine.nickname}}` the preferred Template spelling, while keeping `{{machine.name}}` as a supported alias for the same value. Keep `name` and `--name` in the API and CLI for compatibility. This requires no database migration, new endpoint, or changes to authentication.

## Existing support and gaps

- [`init.ts`](../packages/cli/src/commands/init.ts) already chooses `--name` or the hostname for a new registration. It does not ask a person for a nickname. On an already registered Machine, `init --name` currently does not update the name.
- [`machines.update`](../packages/contract/src/index.ts) accepts an optional name; the [server](../apps/web/src/api/router.ts) allows a Machine token to update itself and a browser session to update its user's Machines.
- The [web Machine detail page](../apps/web/src/routes/_app/machines.$machineId.tsx) already has a Name/Rename form. Improve and relabel this form rather than build another one.
- The same page has a Revoke action. Its existing `machines.revoke` endpoint actually deletes the Machine and cascades removal of its token, Variables, and Variable history. Expose that behavior clearly as “Delete Machine”; reuse the endpoint and ownership checks.
- The shared name schema already trims input and requires 1–100 characters. Expose that existing validation to the CLI for consistent feedback.
- [`PendingLogin`](../packages/cli/src/config.ts) does not store the selected name, so a name passed to `init --no-wait` is currently lost when the next invocation resumes without `--name`.
- [`sync.ts`](../packages/cli/src/commands/sync.ts) uses the current server name to populate the `machine.name` Built-in Variable.
- The [Template engine](../packages/template/src/index.ts) currently recognizes only `machine.name`, `machine.os`, and `agent` as Built-in Variables. It rejects `machine.nickname` today. The [Template page](../apps/web/src/routes/_app/index.tsx) lists the existing Built-ins, and [CodeEditor](../apps/web/src/components/CodeEditor.tsx) is currently a textarea without suggestions. Both rendering and editor support are part of this plan.

## Intended behavior

### First-time CLI setup

```text
$ agentsync init --server <server>
Machine nickname
› Work laptop

✓ Registered Machine Work laptop
```

1. If `--name` is supplied, validate and use it without asking.
2. Otherwise, resume a saved nickname from an unexpired pending registration for the same server.
3. Otherwise, at an interactive terminal, ask for a nickname with the hostname prefilled. Enter accepts the default; the person can replace it.
4. In JSON, `--yes`, CI, and other noninteractive modes, retain the hostname default without asking. Continue to respect the CLI's existing prompt policy.
5. Resolve and validate the name before starting registration. Store it as an optional `name` in `PendingLogin` before the `--no-wait` return. This keeps `init --name "Work laptop" --no-wait` followed by `init` consistent.
6. An explicit new `--name` on resume overrides the saved pending name. Older pending configs without this property use the normal prompt/default rules. Expired or different-server registrations do not inherit the old pending nickname.

Extend the current `Io.text` / `Context.text` boundary with optional initial-value and validation options, implemented by the terminal adapter for rich and plain prompts. Keep existing text callers unchanged. Explicit empty/whitespace `--name` should return usage exit 2, not silently fall back to another name. Validate generated defaults too; if an unusual hostname is invalid in noninteractive mode, request `--name` with a useful error.

### Rename from the CLI

```sh
agentsync rename "Home server"
agentsync rename "Home server" --json --yes
```

Add a small top-level `rename <nickname>` command for the current registered Machine. Require exactly one positional nickname; quoting supports spaces. Missing, empty, or overlong input returns usage exit 2. No additional confirmation is needed for a valid explicit rename.

Call `machines.update({ machineId: ctx.config.machineId, name })` through the existing authenticated client. Send only the name so this command cannot overwrite Targets with a stale list. Return the updated server value:

```text
✓ Machine nickname saved: Home server
```

JSON result: `{ "ok": true, "machine": { "id": "…", "name": "Home server" } }`. Preserve the existing auth/error exits and one-document JSON behavior. If the request fails, report the failure and allow retry; do not claim the nickname was saved. A retry is safe because setting the same name again is idempotent.

Also make `init --name "Home server"` update an already registered Machine for consistency with its flag. An ordinary repeated `init` must retain the server nickname, including one changed from the web. When adding Targets and renaming in the same init invocation, combine the intended changes into the existing update call. Use the returned Machine in final output and JSON.

`rename` updates metadata only; it does not run setup again or write Targets. `init` retains its normal setup-and-sync behavior.

### Rename from the web

On the existing Machine detail page:

- Relabel the input to “Nickname” and the button to “Save nickname.” Keep the current nickname prefilled.
- Apply the same trimmed 1–100-character rule. Disable saving when unchanged or invalid, and while the request is pending.
- Save through the existing `machines.update` endpoint. Use the returned value, refresh route data, and show concise success/error feedback. Clear stale errors after success; keep typed input on failure.
- Update the heading and Machines list after save/invalidation. A CLI rename appears on the next fetch/refresh; no realtime infrastructure is required.
- When fresh data for the same Machine arrives, refresh a clean input from the server. Preserve unsaved input and indicate that the saved name changed if it differs. Navigation to a different Machine continues to reset the form through its existing keyed component.

### Built-in Variable and editor suggestions

Support the nickname in substitutions and conditions:

```text
This Machine is {{machine.nickname}}.

{{if machine.nickname == "Work laptop"}}
Use the work configuration.
{{end}}
```

| Expression | Meaning |
| --- | --- |
| `{{machine.nickname}}` | The current editable nickname; preferred spelling for new Templates. |
| `{{machine.name}}` | Compatible alias that resolves to exactly the same nickname. |
| `{{machine.os}}` | Existing operating-system Built-in Variable. |
| `{{agent}}` | Existing agent Built-in Variable. |

Extend the shared engine's Built-in registry and lookup to map both nickname spellings to `context.builtins.machine.name`. Keep the rendering context and server payload unchanged. Validation must recognize the alias in substitutions and `==` / `!=` conditions. `referencedVariables()` must exclude it, so setup never asks a person to supply a `machine.nickname` Variable and sync never reports it as unset. Keep it reserved against user-defined Variables; genuinely unknown Built-in names must still fail validation.

Export lightweight Built-in metadata from the shared Template package, including descriptions and the compatibility-alias label. Use the same definitions in the engine and editor so the accepted names and suggestions cannot drift apart.

Add completion support to the existing textarea editor rather than replace it with a new editor framework:

- In the editable Template, typing `{{` opens Built-in suggestions; typing `{{machine.` filters to Machine entries, including **`machine.nickname` — Editable Machine nickname**. Also recognize the variable position after `{{if ` so nickname conditions are discoverable.
- Prefer `machine.nickname` in the list. Keep `machine.name` discoverable and label it “Alias of machine.nickname.” Include existing `machine.os` and `agent` entries with descriptions.
- Selecting a suggestion inserts the expression at the caret, or only the variable token in a condition. Preserve surrounding text, existing closing braces, cursor position, selection behavior, and undo. Suppress suggestions for escaped literal Expressions and read-only editors.
- Support mouse selection and Up/Down + Enter; Escape dismisses. Use an accessible suggestion list with announced labels/selection. Normal Enter and Tab retain their editing behavior when the list is closed.
- Show a small “Insert Variable” control using the same suggestions for people who do not know the `{{` trigger. Update the Template syntax help to lead with `{{machine.nickname}}` and explain the older alias.
- The existing live preview must resolve both spellings identically for the selected Machine. Renaming a Machine is reflected when its data is refreshed; no separate nickname Variable needs to be created in the Variables editor.

Initially enable suggestions on the Template editor. Shared rendering/validation makes the new Built-in valid in Conflict resolution too; the same editor completion source can be passed to that editable view when appropriate. Do not show suggestion UI in read-only historical content.

### Delete from the web

On the existing Machine detail page, replace the “Revoke” label with **“Delete Machine”**. Keep deletion separate from nickname editing and visually mark it as destructive. The Machines list already links to each detail page, so a second deletion control in every row is unnecessary for this scope.

1. Ask for confirmation using the current nickname: **“Delete Home server?”** Explain that it stops syncing and permanently removes its registration, token, Variables, and Variable history. Also explain that local instruction files and the shared Template remain. If the page has unsaved edits, make clear that they will be discarded when leaving after deletion. Cancelling preserves the page and drafts.
2. On confirmation, call `rpc.machines.revoke({ machineId })` using the UUID. Nicknames need not be unique and must never identify the deletion target.
3. Disable rename and deletion actions while the mutation is pending. Guard against duplicate submissions and prevent navigation to another Machine from applying a late result to the wrong page; reuse the page's existing navigation ownership helper.
4. On success, invalidate the Machines list, return to `/machines`, and show “Machine deleted.” Handle a `NOT_FOUND` response as an already unavailable Machine and return to the refreshed list. Other failures keep the page and drafts open with a retryable error.
5. The old token stops working immediately for subsequent requests. Normal CLI commands report the existing auth failure; session hooks retain their fail-open behavior. The web cannot remove the local config, hooks, skills, or files on that computer. Document `agentsync logout` followed by `agentsync init` to register it again with a new UUID.

Keep this a permanent deletion with the existing endpoint; no soft-delete state, new API, or schema migration is needed. Other Machines, the shared Template and its history, and existing Conflicts remain. Extend the existing server tests to verify the cascaded deletions explicitly.

## Rendering implications

The nickname is stored in the existing Machine name field and exposed through both `machine.nickname` and `machine.name`. A Template using either spelling in a substitution or condition can Render differently after a rename. Explain this beside the web field and in CLI help: **“Use `{{machine.nickname}}` in your Template. `{{machine.name}}` is a supported alias. Changes apply to Targets on the next sync.”**

After a dedicated CLI rename, include a short hint: “Run `agentsync sync` to apply name-dependent Template changes.” This avoids an extra Template request solely to decide whether to show the hint. Always document the effect in command help. Do not auto-sync from the web or rewrite the Template to replace references to the old nickname. Existing Drift protection still applies when sync eventually runs.

Changing the nickname preserves the UUID, token, Variables, registered Targets, and history. Keep existing names for all current registrations. Duplicate names remain allowed; UUIDs distinguish Machines internally. The current metadata update model remains last successful save wins; this feature does not introduce a new conflict/revision protocol.

Release the updated shared engine in the server and CLI before encouraging use of the new spelling in the web editor. Older CLIs reject `machine.nickname`, so the release notes and editor help must tell users to update AgentSync on every Machine before adopting it. Existing Templates keep working through `machine.name`; do not automatically rewrite their text.

## Delivery plan

| Step | Changes | Acceptance |
| --- | --- | --- |
| 1. Name selection and validation | Export/reuse the shared name validator; extend text prompt options in `io.ts`, `context.ts`, `terminal.ts`, and the harness; update `init.ts` and optional pending-name config. | Interactive setup accepts a manually entered name or hostname default; flags bypass the question; `--no-wait` resumes with the selected name; invalid explicit names fail before registration. |
| 2. CLI updates | Add `commands/rename.ts`; wire command/help in `cli.ts`; honor `init --name` on an existing registration. | Rename works without rerunning setup, JSON reports the saved name, repeated init preserves web edits, and identity/token/Targets stay intact. |
| 3. Web form | Improve the existing form in `machines.$machineId.tsx`; adjust list labels if needed. | Save is disabled during requests; success and errors are clear; headings/list refresh; failed and unsaved input is retained. |
| 4. Template support and editor suggestions | Add nickname lookup/validation and shared Built-in metadata in `packages/template`; wire completions, insertion, syntax help, and preview into `CodeEditor.tsx` and the Template page. | New and old spellings render identically in substitutions/conditions; nickname is suggested and insertable; no missing-Variable prompts; existing Template syntax remains valid. |
| 5. Web deletion | Relabel the existing Revoke action as Delete Machine; clarify confirmation, pending/error states, list invalidation, and navigation. Reuse `machines.revoke`. | Confirmed deletion removes the correct UUID and its dependent records; cancel/error preserves drafts; list refreshes; old token is rejected; other Machines and the shared Template remain. |
| 6. Verification, docs, and release | Extend existing Template, CLI, API, and web tests; update Template/CLI README, help, and packaged agent skill with nickname examples, alias semantics, and deleted-Machine recovery. Publish engine-compatible CLI/server before promoting the new spelling. | Cross-client renames and preview agree; old Templates remain valid; all affected package tests/typechecks pass; upgrade guidance is visible. |

## Focused verification

- CLI setup: manual nickname; Enter accepts default; explicit `--name` skips the question; trimming and 1/100-character boundaries; invalid values; cancellation before registration; no question in JSON/`--yes`/noninteractive mode.
- Pending registration: first invocation selects a nickname, a second resumes it; explicit override; older config without a pending name; expiry/server change does not leak an old default.
- Registered Machine: CLI rename changes only the name; `init --name` also updates it; ordinary init preserves a web rename; UUID/token/Variables/Targets remain associated with the same registration.
- API: retain existing self-update and cross-user/cross-Machine authorization tests. Add name-only update assertions and shared validation coverage; use the real server contract in these tests.
- Web: submit the nickname and correct UUID; pending state; failure retains input; successful retry clears error; fresh server data updates clean state without overwriting a dirty draft; navigation does not leak one Machine's draft into another.
- Web deletion: cancelling sends no request; confirming sends the intended UUID even with duplicate nicknames; only one request runs while pending; success refreshes the list and leaves the detail page; an already deleted Machine is handled; failure retains input/drafts and allows retry. Verify navigation during a pending request does not redirect the wrong page.
- Deletion effects: Machine row, token, Variables, and Variable history are removed; another user's request is denied; other Machines, shared Template/history, and Conflicts remain. The old token returns auth exit 5 for ordinary CLI commands; hook mode still exits 0. Local Target files stay in place.
- Rendering: `machine.nickname` and `machine.name` produce the same value in substitutions, equality, and inequality conditions, including after a rename. Both remain excluded from missing/user Variables. Unknown Built-ins still fail. CLI sync, web preview, and Conflict validation agree. A rename changes the next Render without producing false Drift for an otherwise unedited Target; genuine hand edits remain protected. A rename itself writes no Target.
- Editor: suggestions after `{{`, `{{machine.`, and `{{if `; keyboard/mouse insertion at the caret; existing braces and surrounding text preserved; undo works; Escape dismisses; escaped/read-only content does not trigger completion; accessible labels; existing alias remains discoverable. The preview renders the selected Machine's nickname.
- Run appropriate CLI/web tests and typechecks after implementation. This planning change adds documentation only; no runtime behavior was changed or certified.
