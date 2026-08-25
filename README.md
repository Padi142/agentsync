# AgentSync

AgentSync is an open source starting point for keeping `AGENTS.md`,
`AGENT.md`, and `CLAUDE.md` instructions available across machines.

The repository contains a Cloudflare Workers application and a small CLI
package. The web app has a Better Auth + Drizzle D1 integration, a typed oRPC
HTTP API, and a small file editor to exercise the data model.

The sync engine, hook installers, revision history, email delivery, and CLI
authentication are intentionally not implemented yet. The CLI currently makes
the boundary explicit instead of pretending that local files can sync.

## Layout

- `apps/web` — TanStack Start SSR app, Hono API adapter, oRPC procedures,
  Better Auth, and Drizzle schema/migrations.
- `packages/cli` — published-package skeleton for the future `agentsync`
  command.

## Local setup

Requirements: Node.js 22+ and pnpm 10+.

```sh
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars
pnpm db:migrate:local
pnpm dev
```

The local Worker uses a local D1 database. `pnpm db:migrate:local` is safe for
local state and does not contact a remote Cloudflare database.

Before deploying, replace the placeholder D1 database ID in
`apps/web/wrangler.jsonc`, configure `BETTER_AUTH_URL`, and add
`BETTER_AUTH_SECRET` as a Worker secret. Deployment is deliberately not part
of the local scaffold.

## API shape

- `GET|POST /api/auth/*` — Better Auth endpoints for email/password sessions.
- `/rpc/*` — oRPC procedures. File procedures require a Better Auth session,
  scope every query by the current user, and use an expected revision on
  updates to detect concurrent edits.

The current update path protects against lost writes, but it does not yet
persist immutable history. A future history implementation should use a D1
batch or trigger so the file update and revision record are atomic.

## Current auth limits

Email verification, password reset email delivery, social login, rate limits,
CSRF policy hardening, and production secret management still need to be
designed before a public deployment. The local email/password flow is a
development starting point.

## Commands

```sh
pnpm typecheck
pnpm build
pnpm db:generate
pnpm db:migrate:local
pnpm --filter @agentsync/cli start --help
```

## License

MIT © 2026 Matyas Krejza
