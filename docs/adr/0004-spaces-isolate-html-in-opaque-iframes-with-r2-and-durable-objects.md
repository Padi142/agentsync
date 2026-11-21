# Spaces store blobs in R2, push live updates via Durable Objects, and sandbox HTML in opaque iframes

Space file contents are stored in Cloudflare R2 (latest version only, no per-file history or change log) with metadata in D1, while live updates to open browsers and `agentsync space pull --watch` fan out through one Durable Object per Space using the WebSocket Hibernation API (included in the Cloudflare Workers Paid plan with zero idle compute duration). Because Spaces serve untrusted agent-generated HTML and assets, HTML previews render inside `<iframe sandbox="allow-scripts">` without `allow-same-origin` so scripts execute in a unique opaque origin that cannot read WorkOS session cookies or call `/rpc/*`, with relative asset URLs rewritten to CORS-enabled raw Space endpoints; direct raw HTML downloads are served with `Content-Disposition: attachment` and a restrictive CSP.

## Considered Options

- **Store file blobs in D1**: rejected because D1 row and database limits fit poorly with images, multi-file reports, and 25 MB files, whereas R2 provides object storage with zero egress fees.
- **Polling instead of Durable Objects**: rejected because the deployment runs on the Workers Paid plan, where hibernating Durable Object WebSockets provide instant updates for both browser viewers and CLI `--watch` without polling latency or idle compute charges.
- **Serve HTML directly on `agentsync.krejzac.cz`**: rejected because arbitrary scripts in an HTML report would share the app origin and could steal sessions or call authenticated APIs.
- **Dedicated wildcard sandbox subdomain (e.g. `*.spaces.krejzac.cz`)**: rejected for v1 to avoid extra DNS, TLS, and multi-origin deployment complexity when an opaque sandboxed iframe already isolates cookies and `/rpc/*`.
