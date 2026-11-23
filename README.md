# AgentSync

AgentSync is an open source starting point for keeping `AGENTS.md`,
`AGENT.md`, and `CLAUDE.md` instructions available across machines.

The web app uses TanStack Start, WorkOS AuthKit, Cloudflare Workers + D1,
Drizzle, and a typed oRPC API that implements `@agentsync/contract`: the
Template, Machines and their Variables (with revision history), Conflicts, and
Machine registration through the WorkOS device flow, and Skills (agent skills from public GitHub
repositories, pinned to a commit; see `docs/adr/0002-…`), and Spaces (live-updating files shared
through a Share Link; see [Spaces](#spaces)). The `agentsync` CLI
(`packages/cli`) Renders the Template into each agent's Global Instructions and keeps
them current from Claude Code and Codex `SessionStart` hooks, a pi extension and an OpenCode plugin.

The web UI has five sections. **Template** edits the Template (live syntax
errors, Cmd/Ctrl+S) beside a per-Machine, per-agent preview that renders the
Markdown and underlines text that came from a Variable, with History (rollback) and
Conflicts (`/conflicts`) as views of it. **Machines** manages each Machine's nickname,
Variables and their history, with copyable CLI commands, and **Add a Machine** (`/setup`)
gives the install command and agent setup prompt (from `packages/cli/setup-prompt.md`).
**Skills** (`/skills`) adds skills from skills.sh, pins them, assigns them to Machines, and
shows updates with their audits and changed files, each Machine's state, and skills found on
Machines.
**Spaces** (`/spaces`) lists the account's Spaces and manages their lifecycle; the public viewer is
`/s/<share-token>`.
**Docs** (`/docs`, public) is written as Markdown in `apps/web/src/docs/`. Pages load
their data in the browser through the oRPC client (the root route sets
`ssr: false`); the server renders only the document shell. Device approval
needs no page here: WorkOS AuthKit hosts the `verification_uri`.

## Layout

- `apps/web` — React web UI, Hono API, WorkOS authentication, and D1 schema/migrations.
- `packages/cli` — the `agentsync` CLI, its hooks and agent skills. See its README.
- `packages/contract` — the oRPC API contract. See its README for the auth kind of each procedure.
- `packages/template` — the Template Expression grammar: Render, validate, and inspect Templates.

## Local setup

Use Node.js 22.20+ and pnpm.

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

Skills read public GitHub repositories. Set `GITHUB_TOKEN` to a fine-grained GitHub token
with no permissions (public read only): without one, GitHub allows 60 requests an hour per IP,
which is not enough to add Skills. It is optional for tests, which fake GitHub.

For this development server, register `http://100.82.53.91:3000/callback`
as a redirect URI in WorkOS and use the same value in `.dev.vars`.
Set the **Initiate login URI** to `http://100.82.53.91:3000/login` and the
**Sign-out redirect** to `http://100.82.53.91:3000/` in the WorkOS dashboard.
Login redirects to its configured origin so that the login cookie is available
at the callback.

Development uses the WorkOS **sandbox** environment (`.dev.vars`); the deployed
Worker uses **production**. Production's client ID and redirect URI are `vars` in
`wrangler.jsonc`, and `WORKOS_API_KEY` and `WORKOS_COOKIE_PASSWORD` are Worker
secrets. In the production environment, register the HTTPS versions of the three
URLs above, enable CLI Auth for Machine registration, and give each social
provider (Google) your own OAuth credentials: the sandbox's shared ones do not
work there. The environments share no users, so each has its own WorkOS user
IDs; migration `0007_workos_production.sql` cleared the sandbox IDs when production
went live, and people reclaimed their accounts by verified email.

Enable your desired sign-in methods (including Google) in the WorkOS dashboard.
The application delegates account creation, email verification, and password
recovery to the hosted AuthKit flow.

This app uses the WorkOS server SDK (`@workos-inc/node`) with Hono routes.
It does not need `@workos-inc/authkit-js` or a standalone `.html` file: TanStack
Start renders the document. Installer checks for a vanilla JavaScript client
do not apply to this integration. `redirectUri` is explicitly supplied when
creating the authorization URL.

## Authentication and data migration

- "Sign in" opens the app's own dialog, so people do not pass through the hosted
  AuthKit page. `GET /login?provider=google|github` redirects straight to that
  provider, using PKCE and a signed, short-lived HttpOnly login cookie to validate
  the OAuth state. Without a provider it redirects to the hosted AuthKit page.
- `POST /login/email` emails a six-digit code (WorkOS Magic Auth, which must be
  enabled in the WorkOS dashboard) and `POST /login/email/verify` exchanges it for
  the session. The CLI's device approval page is still hosted by WorkOS.
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

## Spaces

A Space is a set of files an agent shares through an unguessable Share Link, live-updating and
readable without an account (terms in `GLOSSARY.md`). Blobs live in the R2 bucket `agentsync-spaces`
under `<spaceId>/<file id>`, metadata in D1 (`space`, `space_file`; migration `0008_spaces.sql`),
and live updates fan out through one `SpaceHub` Durable Object per Space over hibernating
WebSockets.

**Trust model** (`docs/adr/0003-…`, `docs/adr/0004-…`):

- A Machine token can only create a Space (`spaces.create`). The answer carries the Space's Write
  Token (`asw_…`) once; only its SHA-256 is stored, and the CLI never saves it, so write access
  stays with the creating session. Another session on the same Machine, or anyone with the Share
  Link, can only read.
- Every file write takes the Write Token, and nothing else: no Machine token, no cookie.
- Owner management (list, extend, make permanent, revive, make private, rotate the Share Link,
  delete a Space or a file) is session-only, in `/spaces`. The browser cannot edit file contents.
- Untrusted HTML previews render in `<iframe sandbox="allow-scripts">` without
  `allow-same-origin`, so scripts run in an opaque origin that can't read the session cookie or
  call `/rpc/*`. Relative assets resolve to the CORS-enabled raw routes through an injected
  `<base>`. Raw HTML, SVG and anything not obviously inert download as attachments with
  `Content-Security-Policy: sandbox; default-src 'none'` and `nosniff`.
- Every path, on upload, raw fetch, ZIP and `pull`, goes through the contract's
  `normalizeSpacePath`: relative, `/`-separated, no `..`, leading `/` or control characters.

**Routes**:

- `/rpc/spaces.*` — `create` (Machine token), `list`, `get`, `update`, `rotateLink`, `delete`,
  `deleteFile` (session).
- `GET|PATCH|DELETE /api/spaces/:id` and `PUT|DELETE /api/spaces/:id/files/<path>` — Write Token
  as `Authorization: Bearer`. `PUT` takes the raw body (at most 25 MB) with its `Content-Type`, and
  verifies an optional `X-Content-SHA256`. Writes work while a Space is active or private and fail
  with `SPACE_EXPIRED` (410) once it expired; `GET` works in any state. A wrong token and an unknown
  ID answer the same.
- `POST /api/spaces/:id/uploads`, `PUT …/uploads/<upload>/parts/<n>`, `POST …/uploads/<upload>/complete`
  — a multipart upload, for files over 25 MB, in 25 MB parts that stream straight to R2. Completing
  reads the joined object back once to check its SHA-256 and the limits. `DELETE …/uploads/<upload>`
  aborts one, and R2 drops unfinished uploads after 7 days.
- `/s/<token>` — the viewer for `Accept: text/html`, a Markdown digest for `text/markdown` (or
  `/s/<token>.md`), JSON for `application/json` (or `/s/<token>.json`). `/s/<token>/raw/<path>`
  streams a file, `/s/<token>/download.zip` streams a store-mode ZIP, `/s/<token>/ws` upgrades to
  the Space's `SpaceHub`. They serve active Spaces only: unknown or private is 404, expired 410.

Errors on the HTTP routes are `{ error: { code, message } }` (`spaceErrorSchema`).

**Limits**: 500 MB per file, 1 GB per Space, 2 GB per user (`SPACE_LIMITS`).

**Lifecycle**: a Share Link works 7 days by default, up to 365 days, or forever. Status is derived
from `isPrivate` and `expiresAt`, never stored: `active`, `expired` (owner-only for a 30-day grace
period; reviving it keeps the same Share Link) or `private` (link off, never purged automatically).
The 10-minute cron also purges Spaces 30 days past expiry, and their R2 prefix.

Locally, `pnpm dev` and the tests simulate R2 and the Durable Object; there is nothing to set up.
Deploying needs a one-time setup; see [Deployment](#deployment).

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
```

Tests use an isolated local D1 database and mock WorkOS token exchanges and
device endpoints. They cover callback state/PKCE, refresh and logout, CSRF
protection, legacy user linking, Template revisions, conflicts and rollback, the
Conflict lifecycle, device registration, the Machine-token boundary,
revocation, and Skills (against a fake GitHub served from real git repositories). To verify the real provider flow, open `/login` while signed out,
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
pnpm run deploy
```

Spaces need a one-time setup on the Cloudflare account before the first deploy that includes them.
Enable R2 on the account (Cloudflare dashboard → R2), then create the bucket:

```sh
pnpm --filter @agentsync/web exec wrangler r2 bucket create agentsync-spaces
```

The `SpaceHub` Durable Object needs nothing by hand: its migration (`v1` in `wrangler.jsonc`) ships
with `pnpm run deploy`.

A cron trigger runs the Skills update check every 10 minutes (`triggers` in `wrangler.jsonc`;
each run checks the few Skills not checked for a day) and purges Spaces past their grace period. Under `pnpm dev`, run it with
`curl "http://<host>:<port>/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*"`.

Remote migrations target the deployed database; local development continues to
use its own D1 database. `pnpm run deploy` builds the shared packages and web app,
applies pending remote migrations, then uploads the generated Worker and static assets.
Deployment stops if a migration fails, so new code cannot ship ahead of its schema.

`WORKOS_API_KEY`, a separate deployment `WORKOS_COOKIE_PASSWORD` and `GITHUB_TOKEN` are
stored as Worker secrets. Later deployments preserve them. To set or rotate one:

```sh
pnpm --filter @agentsync/web exec wrangler secret put WORKOS_API_KEY
pnpm --filter @agentsync/web exec wrangler secret put WORKOS_COOKIE_PASSWORD
pnpm --filter @agentsync/web exec wrangler secret put GITHUB_TOKEN
```

The HTTPS callback is registered in WorkOS. Set the application's **Initiate
login URI** to `https://agentsync.krejzac.cz/login` and allow
`https://agentsync.krejzac.cz/` as a **Sign-out redirect** in the WorkOS
dashboard. These settings require WorkOS dashboard access; the API key can
register callbacks but cannot manage those two settings.

## License

MIT © 2026 Matyas Krejza
