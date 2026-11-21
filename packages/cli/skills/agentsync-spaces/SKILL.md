---
name: agentsync-spaces
description: Shares files through a live AgentSync Space with `agentsync space`, and reads Spaces others shared. Use when the user wants to share a report, an HTML or Markdown page, images or a folder of output with someone or with another agent; when given an AgentSync Share Link (`https://…/s/<token>`) to read or pull; or when holding a Write Token (`asw_…`).
---

# AgentSync Spaces

A **Space** is a set of files on the AgentSync server behind a **Share Link** (`https://<server>/s/<token>`). Anyone with the link sees the files live in a browser, without an account. Each file keeps only its latest version. Creating a Space returns its **Write Token** (`asw_…`), the only key that changes it.

Run every command with `--json --yes`. Stdout is one JSON document (`ok`, the data, or `error.message`). Exit 2 is a usage error (`agentsync space --help`). Exit 5 means the credential is missing or wrong: for `create`, this Machine is not registered (`agentsync init`); for the other writes, the Write Token. Other failures exit 1 with `error.code`, such as `SPACE_EXPIRED` or `SPACE_FULL`.

## When to create one

Create a Space when output is meant to be looked at by someone else: a report, an HTML page or prototype, a Markdown write-up, images, a folder of results, or files for another agent to read. One Space per thing shared: keep updating the same Space as the work changes, so the link stays the same and viewers see each change live. Anyone with the link can read everything in it, so ask the user before putting anything sensitive there.

HTML runs in a sandboxed frame, and relative links resolve inside the Space, so push a page together with its CSS, scripts and images. The viewer opens `index.html`, a single top-level `.html` or `.md`, or `README.md` first.

## Create and write

1. `agentsync space create [path] --title "…" [--summary "…"] [--expires 7d|never] --json --yes`. `path`, a file or a directory, is uploaded in the same step. The answer has `space.id`, `space.shareUrl` and `writeToken`.
2. Hold the Write Token in this session's memory only. It is shown once and the server keeps only its hash. Pass it on every write as `AGENTSYNC_SPACE_TOKEN=asw_… agentsync space …` (preferred) or `--token asw_…`; it never goes into a file, a commit, the Space itself, or a message to anyone. What you share is `shareUrl`.
3. Change the Space, each command with the Write Token:
   - `agentsync space put <id> <local-file> [remote-path]`: add or replace one file.
   - `agentsync space push <id> <local-dir>`: mirror a directory. Uploads new and changed files and removes remote files that are gone locally.
   - `agentsync space rm <id> <remote-path>`: remove one file.
   - `agentsync space update <id> [--title "…"] [--summary "…"] [--expires <n>d|never]`: `--expires` also extends the link.
   - `agentsync space delete <id>`: delete the Space and its link for everyone.
4. Give the user `shareUrl`. Done when the last command exits 0.

Remote paths are relative and `/`-separated; `..` and absolute paths are rejected. Without the Write Token (a new session, or it was lost) a Space can't be changed from the CLI: create a new one, or the owner manages it at `<server>/spaces`.

## Read a Space

Works with any Share Link, without an account or a registered Machine.

- `agentsync space inspect <url> --json`: title, summary, status, expiry and the file list.
- `agentsync space get <url> <remote-path> [--out <path>]`: one file. Without `--out`, a text file is printed (`text` in the JSON); a binary file needs `--out`.
- `agentsync space pull <url> <local-dir> [--watch]`: every file. `--watch` keeps `<local-dir>` updated live until stopped, so run it in the background.
- Without the CLI: `<url>.md` is a Markdown digest of the Space, `<url>.json` its metadata, `<url>/raw/<path>` a file's bytes.

## Limits and lifecycle

- 25 MB per file, 100 MB per Space, 500 MB per account.
- A Share Link works 7 days by default; `--expires <n>d` sets up to 365 days, `never` makes it permanent.
- Once it expires, the link stops working and writes fail with `SPACE_EXPIRED`. Only the owner can revive it, signed in at `<server>/spaces`, which brings back the same link. 30 days after expiring, the Space is deleted.
- In `/spaces` the owner can also extend, make a Space permanent, mark it private (link off, Write Token still works, never deleted automatically), rotate its link, and delete it or single files.
