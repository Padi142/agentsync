# AgentSync

AgentSync is an open source starting point for keeping `AGENTS.md`,
`AGENT.md`, and `CLAUDE.md` instructions available across machines.

The web app uses TanStack Start, WorkOS AuthKit, Cloudflare Workers + D1,
Drizzle, and a typed oRPC API that implements `@agentsync/contract`: the
Template, Machines and their Variables (with revision history), Conflicts, and
Machine registration through the WorkOS device flow. The `agentsync` CLI
(`packages/cli`) Renders the Template into each agent's Global Instructions and keeps
them current from Claude Code and Codex `SessionStart` hooks and a pi extension.

The web UI has three sections. **Template** edits the Template (live syntax
errors, Cmd/Ctrl+S) beside a per-Machine, per-agent preview that renders the
Markdown and underlines text that came from a Variable, with History (rollback) and
Conflicts (`/conflicts`) as views of it. **Machines** manages each Machine's nickname,
Variables and their history, with copyable CLI commands, and **Add a Machine** (`/setup`)
gives the install command and agent setup prompt (from `packages/cli/setup-prompt.md`).
**Docs** (`/docs`, public) is written as Markdown in `apps/web/src/docs/`. Pages load
their data in the browser through the oRPC client (the root route sets
`ssr: false`); the server renders only the document shell. Device approval
needs no page here: WorkOS AuthKit hosts the `verification_uri`.

## Layout

- `apps/web` — React web UI, Hono API, WorkOS authentication, and D1 schema/migrations.
- `packages/cli` — the `agentsync` CLI, its hooks and agent skill. See its README.
- `packages/contract` — the oRPC API contract. See its README for the auth kind of each procedure.
- `packages/template` — the Template Expression grammar: Render, validate, and inspect Templates.

## Local setup

Use Node.js 22.12+ and pnpm.

```sh
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars
# Fill in the WorkOS values before starting the app.
pnpm db:migrate:local
pnpm --filter @agentsync/web dev --host 0.0.0.0
```

On this server the app is reachable at `http://100.82.53.91:3000` over Tailscale.
Local migrations only touch the local D1 database.

## WorkOS configuration

The Cloudflare Worker reads `apps/web/.dev.vars`, not the installer's root
`.env.local`. Keep credentials out of source control and client bundles.

- `WORKOS_API_KEY` — API key for the WorkOS environment.
- `WORKOS_CLIENT_ID` — client ID from that same environment.
- `WORKOS_COOKIE_PASSWORD` — a random secret of at least 32 characters.
- `WORKOS_REDIRECT_URI` — the exact application URL ending in `/callback`.

For this development server, register `http://100.82.53.91:3000/callback`
as a redirect URI in WorkOS and use the same value in `.dev.vars`.
Set the **Initiate login URI** to `http://100.82.53.91:3000/login` and the
**Sign-out redirect** to `http://100.82.53.91:3000/` in the WorkOS dashboard.
For production, use your HTTPS domain for all three URLs. Login redirects to
its configured origin so that the login cookie is available at the callback.

Enable your desired sign-in methods (including Google) in the WorkOS dashboard.
The application delegates account creation, email verification, and password
recovery to the hosted AuthKit flow.

This app uses the WorkOS server SDK (`@workos-inc/node`) with Hono routes.
It does not need `@workos-inc/authkit-js` or a standalone `.html` file: TanStack
Start renders the document. Installer checks for a vanilla JavaScript client
do not apply to this integration. `redirectUri` is explicitly supplied when
creating the authorization URL.

## Authentication and data migration

- `GET /login` immediately redirects to AuthKit, using PKCE and a signed,
  short-lived HttpOnly login cookie to validate the OAuth state.
- `GET /callback` exchanges the authorization code, provisions the local user,
  and sets an encrypted HttpOnly session cookie. Cookies are Secure on HTTPS.
- `GET /login?returnTo=/conflicts/<id>` comes back to that path after sign-in. The
  path travels in the signed login cookie and must start with a single `/`; `//`,
  `/\`, absolute URLs, whitespace and control characters fall back to `/`.
- `GET /api/auth/get-session` returns only the local user's ID, name, and email.
- `POST /logout` clears the cookie and redirects through WorkOS to end the session.
- `/rpc/*` implements `@agentsync/contract`. A browser authenticates with the session
  cookie (refreshed as above); a Machine sends `Authorization: Bearer <Machine token>`.
  Every query is scoped to the caller's user, and a Machine token reaches only its
  own Machine record and Variables. Each call with a token updates the Machine's
  `lastSeenAt`.
- Mutating API requests must carry the configured application's Origin header, or
  neither an Origin nor cookies (the CLI), which carries no ambient credentials.
- `machines.deviceStart`/`devicePoll` run the WorkOS AuthKit CLI Auth device flow
  server-side. The server remembers each device code (as a hash) until it is used, so
  unknown or reused codes are `invalid` and a code registers at most one Machine. Only
  the SHA-256 hash of each Machine token is stored; revoking a Machine deletes it.

Template and Variable writes insert the new revision row and move the head row in one
D1 batch, conditional on `expectedRevision`; otherwise they fail with `CONFLICT`.
`conflicts.create` merges the losing edit with the current Template line by line
(diff3) and marks only the overlapping lines with `<<<<<<<`/`=======`/`>>>>>>>`.

Migration `0003_sync_engine.sql` replaces the old `file` table with the sync tables
(`template`, `template_revision`, `machine`, `machine_credential`, `machine_variables`,
`machine_variables_revision`, `conflict`, `device_authorization`). Files saved before
it are dropped; there is no production data.

Migration `0002_workos_users.sql` adds a unique WorkOS identity to the existing
user table. A WorkOS user with a
verified email can claim the matching legacy account on first sign-in; an
unverified email or an email already linked to another WorkOS identity cannot.
New WorkOS users get a local user record before anything is saved.

Better Auth sessions and passwords are no longer used. Existing users sign in
or create an account through WorkOS. The legacy account/session/verification
tables are retained for migration safety, but no runtime code reads them.
Passwords are not imported into WorkOS.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
```

Tests use an isolated local D1 database and mock WorkOS token exchanges and
device endpoints. They cover callback state/PKCE, refresh and logout, CSRF
protection, legacy user linking, Template revisions, conflicts and rollback, the
Conflict lifecycle, device registration, the Machine-token boundary, and
revocation. To verify the real provider flow, open `/login` while signed out,
complete AuthKit sign-in, save the Template, and sign out. This needs valid WorkOS credentials and dashboard URLs.

## Deployment

The app is deployed at <https://agentsync.krejzac.cz> as the
`agentsync` Cloudflare Worker, backed by the `agentsync-db` D1 database.
`apps/web/wrangler.jsonc` contains the account, database binding, WorkOS client
ID, and HTTPS callback URL. The callback's origin is the only origin the app accepts
browser requests from, so the web app works only on that domain; the Worker's
`workers.dev` URL still serves the CLI, which sends no Origin. It currently uses the
existing WorkOS staging environment.

Use Node.js 22.12+ and authenticate Wrangler for the configured Cloudflare
account (`pnpm --filter @agentsync/web exec wrangler login`, or set
`CLOUDFLARE_API_TOKEN`). From the repository root:

```sh
pnpm db:migrate:remote
pnpm run deploy
```

Remote migrations target the deployed database; local development continues to
use its own D1 database. `pnpm run deploy` builds the shared packages and web app,
then uploads the generated Worker and static assets.

`WORKOS_API_KEY` and a separate deployment `WORKOS_COOKIE_PASSWORD` are stored as
Worker secrets. Later deployments preserve them. To set or rotate either secret:

```sh
pnpm --filter @agentsync/web exec wrangler secret put WORKOS_API_KEY
pnpm --filter @agentsync/web exec wrangler secret put WORKOS_COOKIE_PASSWORD
```

The HTTPS callback is registered in WorkOS. Set the application's **Initiate
login URI** to `https://agentsync.krejzac.cz/login` and allow
`https://agentsync.krejzac.cz/` as a **Sign-out redirect** in the WorkOS
dashboard. These settings require WorkOS dashboard access; the API key can
register callbacks but cannot manage those two settings.

## License

MIT © 2026 Matyas Krejza
