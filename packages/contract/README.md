# @agentsync/contract

The AgentSync API, defined contract-first with `@orpc/contract` and zod. It holds
procedure signatures and schemas only. `apps/web` implements it with
`implement(contract)`, and the CLI and web app call it with a typed oRPC client.

## Auth kinds

Each procedure lists the auth kinds it accepts in its meta
(`procedure['~orpc'].meta.auth`), so the server can enforce them in one middleware.

- **session**: the WorkOS AuthKit session cookie of a signed-in browser.
- **machine**: a per-Machine token sent as `Authorization: Bearer <token>`.
  `machines.devicePoll` returns it once. A Machine token only reaches its own
  Machine; asking for another Machine returns `NOT_FOUND`.

| Procedure | session | machine | Errors |
|---|:-:|:-:|---|
| `health` | public | public | |
| `session` | public | public | |
| `template.get` | ✓ | ✓ | |
| `template.put` | ✓ | ✓ | `CONFLICT`, `INVALID_TEMPLATE` |
| `template.history` | ✓ | | |
| `template.revision` | ✓ | | `NOT_FOUND` |
| `template.rollback` | ✓ | | `NOT_FOUND`, `CONFLICT` |
| `machines.list` | ✓ | | |
| `machines.get` | ✓ | | `NOT_FOUND` |
| `machines.update` | ✓ | own | `NOT_FOUND` |
| `machines.revoke` | ✓ | own | `NOT_FOUND` |
| `machines.deviceStart` | public | public | |
| `machines.devicePoll` | public | public | |
| `machines.sync` | | own | |
| `variables.get` | ✓ | own | `NOT_FOUND` |
| `variables.put` | ✓ | own | `NOT_FOUND`, `CONFLICT`, `INVALID_VARIABLE_NAME` |
| `variables.history` | ✓ | | `NOT_FOUND` |
| `conflicts.create` | ✓ | ✓ | `NOT_FOUND` |
| `conflicts.list` | ✓ | ✓ | |
| `conflicts.get` | ✓ | ✓ | `NOT_FOUND` |
| `conflicts.resolve` | ✓ | ✓ | `NOT_FOUND`, `CONFLICT`, `INVALID_TEMPLATE` |
| `conflicts.discard` | ✓ | | `NOT_FOUND` |
| `skills.overview` | ✓ | | |
| `skills.search`, `skills.inspect` | ✓ | | `UNSUPPORTED_SKILL`, `NOT_FOUND`, `UPSTREAM_UNAVAILABLE` |
| `skills.add` | ✓ | | `NOT_FOUND`, `UNSUPPORTED_SKILL`, `SKILL_NAME_TAKEN`, `NO_MATCHING_COMMIT`, `UPSTREAM_UNAVAILABLE` |
| `skills.assign`, `skills.update`, `skills.remove`, `skills.setAutoUpdate`, `skills.history`, `skills.diff` | ✓ | | `NOT_FOUND`, `UPSTREAM_UNAVAILABLE` |
| `skills.updateAll`, `skills.settings` | ✓ | | |
| `skills.report` | | own | |

Every procedure that needs auth can also fail with `UNAUTHORIZED`.

The meta only says which credentials a procedure accepts. The server enforces
the rest in its handlers: every query is scoped to the caller's user, and "own"
procedures check that a Machine token's Machine matches `machineId`.

## Conventions

- Revisions start at 1. Revision `0` is the empty initial Template (or Variable
  map), so the first `template.put` or `variables.put` sends `expectedRevision: 0`,
  and a Conflict whose edit started from nothing has `baseRevision: 0`.
- `CONFLICT` carries `{ currentRevision }`. After a failed `template.put`, call
  `conflicts.create` with the edit's base revision and text.
- `INVALID_TEMPLATE` carries `{ issues: [{ message, line, column }] }`. For
  `conflicts.resolve`, a leftover Conflict marker is reported as an issue too.
- `conflicts.resolve` takes the `expectedRevision` the resolution was merged
  against. On `CONFLICT`, re-fetch the Template, merge again and retry. The
  Conflict's `serverRevision` is history only.
- `machines.devicePoll`: each `pending` result carries the interval to wait before
  the next poll, including WorkOS `slow_down` increases. Registration is
  single-use, so a retried poll after a lost `approved` response gets `invalid`
  and never a second token or Machine. The CLI maps `invalid`, `expired` and
  `denied` to exit code 5.
- `os` is normalised to `macos`, `linux` or `windows` (Node's `darwin` is `macos`,
  `win32` is `windows`).
- Skills are changed only by a signed-in browser. A Machine gets its Skills in
  `machines.sync` (`skills`: name, repository, commit and installed hash) and
  reports what it has with `skills.report`; it can't add or move anything, so a
  stolen Machine token can't push a Skill to other Machines.
- A Pin is resolved by the server from GitHub, never taken from a client:
  `commit` is the newest commit on the default branch that changed the folder,
  `treeSha` GitHub's tree for it, and `installedHash` the tree hash of what the
  `skills` CLI writes (it leaves out `SKILL_COPY_EXCLUDES`). Skill Drift
  compares a folder on disk with `installedHash`.
- Skill names (`skillNameSchema`), `owner/repo` (`repoNameSchema`) and SHAs
  (`gitShaSchema`) are validated on both sides, and none can start with `-`. A
  name is lowercase words joined by single hyphens: what `skills` installs
  without renaming it.
- Each desired Skill carries `sources`: the repository's canonical name and the
  old names GitHub redirects to it. A Machine adopts an existing copy only if
  its lock names one of them.
- Variable names and Template syntax are checked by the server with
  `@agentsync/template`. This package does not depend on the grammar.
