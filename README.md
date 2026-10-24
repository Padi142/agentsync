# AgentSync

AgentSync is an open source starting point for keeping `AGENTS.md`,
`AGENT.md`, and `CLAUDE.md` instructions available across machines.

The web app uses TanStack Start, WorkOS AuthKit, Cloudflare Workers + D1,
Drizzle, and a typed oRPC API. It includes a small instruction file editor.
The sync engine, hook installers, revision history, and CLI authentication
are not implemented yet.

## Layout

- `apps/web` — React SSR app, Hono API, WorkOS authentication, and D1 schema/migrations.
- `packages/cli` — skeleton for the future `agentsync` command.
- `packages/contract` — the oRPC API contract. See its README for the auth kind of each procedure.

## Local setup

Use Node.js 22.12+ and the pnpm version in `package.json`.

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
- `GET /api/auth/get-session` returns only the local user's ID, name, and email.
- `POST /logout` clears the cookie and redirects through WorkOS to end the session.
- `/rpc/*` uses the same session handling, including refreshed session cookies.
  File queries are scoped to the local user and updates require the expected revision.
- Mutating API requests require the configured application's Origin header.

Migration `0002_workos_users.sql` adds a unique WorkOS identity to the existing
user table. Existing files keep their original owner IDs. A WorkOS user with a
verified email can claim the matching legacy account on first sign-in; an
unverified email or an email already linked to another WorkOS identity cannot.
New WorkOS users get a local user record before any files are saved.

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

Tests use an isolated local D1 database and mock WorkOS token exchanges. They
cover callback state/PKCE, refresh and logout, CSRF protection, legacy file
ownership, user isolation, and revision conflicts. To verify the real provider
flow, open `/login` while signed out, complete AuthKit sign-in, create a file,
and sign out. This needs valid WorkOS credentials and dashboard URLs.

## Deployment

Replace the placeholder D1 database ID in `apps/web/wrangler.jsonc`, apply the
migrations to the deployment database, and configure the WorkOS bindings.
Store `WORKOS_API_KEY` and `WORKOS_COOKIE_PASSWORD` as Worker secrets. Configure
`WORKOS_CLIENT_ID` and `WORKOS_REDIRECT_URI` as Worker variables. Deployment is
not part of the local scaffold.

## License

MIT © 2026 Matyas Krejza
