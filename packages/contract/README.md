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
| `conflicts.create` | ✓ | ✓ | |
| `conflicts.list` | ✓ | ✓ | |
| `conflicts.get` | ✓ | ✓ | `NOT_FOUND` |
| `conflicts.resolve` | ✓ | ✓ | `NOT_FOUND`, `CONFLICT`, `INVALID_TEMPLATE` |
| `conflicts.discard` | ✓ | | `NOT_FOUND` |

Every procedure that needs auth can also fail with `UNAUTHORIZED`.

## Conventions

- Revisions start at 1. A head revision of `0` means nothing has been saved yet,
  so the first `template.put` or `variables.put` sends `expectedRevision: 0`.
- `CONFLICT` carries `{ currentRevision }`. After a failed `template.put`, call
  `conflicts.create` with the edit's base revision and text.
- `INVALID_TEMPLATE` carries `{ issues: [{ message, line, column }] }`. For
  `conflicts.resolve`, a leftover Conflict marker is reported as an issue too.
- `conflicts.resolve` fails with `CONFLICT` once the Template has moved past the
  Conflict's `serverRevision`.
- Variable names and Template syntax are checked by the server with
  `@agentsync/template`. This package does not depend on the grammar.
