# Templates

Your Template is ordinary Markdown. Anything inside `{{ }}` is an **Expression**: it's filled in differently for each Machine and each agent.

## Variables

Write `{{name}}` to insert a Variable. You set Variables per Machine, on the Machine's page or from its terminal:

```sh
agentsync vars --var editor=neovim
```

```md
My editor is {{editor}}.
```

A Variable that a Machine doesn't set renders as nothing, and the editor warns you about it.

Names use letters, digits and `_`, and can't start with a digit. `agent`, `machine`, `if`, `else` and `end` are reserved.

## Built-in Variables

AgentSync fills these in for you:

| Expression | Value |
| --- | --- |
| `{{machine.nickname}}` | The name you gave the Machine. Change it on the web or with `agentsync rename`. |
| `{{machine.hostname}}` | The computer's own hostname. |
| `{{machine.os}}` | `macos`, `linux` or `windows`. |
| `{{agent}}` | The agent the file is for, such as `claude`, `codex` or `pi`. |

An unknown `machine.` name, like `{{machine.arch}}`, is an error, so typos are caught when you save.

## Conditions

Show text only on some Machines, or only to some agents:

```md
{{if agent == "codex"}}
Run the tests before you say you're done.
{{else}}
Use the agentsync skill when you change these instructions.
{{end}}
```

- `!=` works too: `{{if machine.os != "windows"}}`.
- `{{else}}` is optional, and blocks can be nested.
- A line that holds only `{{if …}}`, `{{else}}` or `{{end}}` disappears completely, so blocks don't leave blank lines behind.
- There's no `and`/`or`. Nest two blocks instead.

## Writing a literal `{{`

Put a backslash in front: `\{{` renders as `{{`. Expressions are filled in everywhere, including inside code blocks, so escaping is the only way to keep `{{` as it is.

## Errors

A malformed Expression stops the Template from saving, and the editor shows the line and column. The preview keeps showing the last version that parsed while you fix it.
