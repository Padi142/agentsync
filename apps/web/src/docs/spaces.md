# Spaces

A **Space** is a set of files shared through a link: a report, an HTML page, a Markdown write-up, images, or a whole folder of output. Anyone with its **Share Link** sees the files in their browser, without an account, and the page updates live as the files change. Each file keeps only its latest version.

## Sharing from an agent

`agentsync init` installs an `agentsync-spaces` skill, so you can ask your agent to "share this as a Space". To do it yourself:

```sh
agentsync space create ./report --title "Benchmark results"
```

`create` uploads the file or folder and prints the Share Link and a **Write Token**. The agent keeps updating the same Space as its work changes, so the link stays the same.

| Command | What it does |
| --- | --- |
| `agentsync space create [path]` | Creates a Space, uploading a file or folder. `--title`, `--summary`, and `--expires 7d` (up to `365d`) or `never`. |
| `agentsync space put <id> <file> [remote-path]` | Adds or replaces one file. |
| `agentsync space push <id> <dir>` | Mirrors a folder: uploads new and changed files, removes the ones gone locally. |
| `agentsync space rm <id> <remote-path>` | Removes one file. |
| `agentsync space update <id>` | Changes `--title`, `--summary` or `--expires`. |
| `agentsync space delete <id>` | Deletes the Space and its link. |

## The Write Token

Only the Write Token can change a Space's files. It is shown once, the server keeps only a hash of it, and the CLI never saves it: every write passes it with `--token` or the `AGENTSYNC_SPACE_TOKEN` environment variable. So write access stays with the session that created the Space. Another agent on the same Machine, or anyone you send the link to, can only read it.

Once the token is gone, the files stay as they are. You can still manage the Space on the Spaces page.

## Reading a Space

Open the Share Link. A single file fills the page; several get a file tree, opening `index.html`, a single top-level `.html` or `.md` file, or `README.md` first. Pause stops live updates.

The CLI reads any Share Link, with no account or registered Machine needed:

| Command | What it does |
| --- | --- |
| `agentsync space inspect <url>` | Shows the title, summary, status, expiry and files. |
| `agentsync space get <url> <remote-path>` | Downloads one file; `--out <path>` says where. |
| `agentsync space pull <url> <dir>` | Downloads every file. `--watch` keeps the folder updated live. |

Agents without the CLI can fetch `<link>.md` for a Markdown summary of the Space, `<link>.json` for its metadata, `<link>/raw/<path>` for a file, and `<link>/download.zip` for everything.

## How long a Space lasts

- A Share Link works for 7 days unless `--expires` says otherwise, or you extend it or make it permanent on the Spaces page.
- When it expires, the link stops working and the Write Token can't change anything. Only you see the Space, on the Spaces page, for 30 more days, and reviving it there brings it back at the same link. After that, it is deleted.
- Making a Space private turns its link off without a deadline: the Space is never deleted on its own, and its Write Token still works.
- Rotating the link gives the Space a new Share Link, and the old one stops working at once.

## Limits

25 MB per file, 100 MB and 500 files per Space, and 500 MB per account. The Spaces page shows how much you use.

## The Spaces page

The Spaces page lists your active, private and expired Spaces with their files, size and expiry. From there you can open or download any file (or the whole Space as a ZIP) even while it is private or expired, copy a link, extend, make permanent, make private, revive, rotate the link, and delete a Space or single files. Files can't be edited there.

## Safety

Shared HTML runs in a sandboxed frame with its own isolated origin, so its scripts can't reach your AgentSync session. Opening a raw HTML or SVG file downloads it instead of running it on the AgentSync domain.
