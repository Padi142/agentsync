# Spaces use session-scoped Write Tokens and dashboard-only owner management

When an agent creates a Space via `agentsync space create` (authenticated with its Machine token), the server returns a one-time Write Token whose SHA-256 hash is stored on the Space and never saved to `~/.config/agentsync/`. Every CLI upload, update, or deletion on that Space requires that Write Token (`--token` or `AGENTSYNC_SPACE_TOKEN`), so another agent session running on the same registered Machine — or given the Share Link — gets read-only access only. Account-wide owner management (listing Spaces, viewing private or expired Spaces, extending, pinning, reviving, rotating Share Links, and deleting Spaces or individual files) lives exclusively in the signed-in web dashboard (`/spaces`), matching ADR 0002's trust boundary for Skills; the browser cannot edit file contents.

## Considered Options

- **Machine-token writes on any Space owned by the account**: rejected because coding agents run as stateless CLI subprocesses on the same Machine, so another session handed the Share Link would silently gain write and delete access to the first session's Space.
- **Store the Write Token in a local `.agentsync-space` file in the working directory**: rejected because multiple agent sessions in the same repository would share write access and the secret file risks being committed to git.
- **Allow browser editing and Write Token rotation**: rejected to keep Spaces strictly single-writer per creating session; once a session drops its Write Token the Space is frozen until deleted or expired.
