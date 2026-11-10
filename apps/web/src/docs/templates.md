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

A Variable that a Machine doesn't set renders as nothing, and the editor warns you about it. To use something else instead, give it a default after `??`. Then there's no warning:

```md
My editor is {{editor ?? "vim"}}.
```

The default is also used when the Variable is set but empty.

Names use letters, digits and `_`, and can't start with a digit. `agent`, `machine`, `if`, `else` and `end` are reserved.

## Built-in Variables

AgentSync fills these in for you:

| Expression | Value |
| --- | --- |
| `{{machine.nickname}}` | The name you gave the Machine. Change it on the web or with `agentsync rename`. |
| `{{machine.hostname}}` | The computer's own hostname. |
| `{{machine.os}}` | `macos`, `linux` or `windows`. |
| `{{agent}}` | The agent the file is for, such as `claude`, `codex`, `pi` or `opencode`. |

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

Put a check after `if`. You can check a Variable in these ways:

| Check | True when |
| --- | --- |
| `agent == "codex"` | The value is exactly `codex`. |
| `machine.os != "windows"` | The value is anything but `windows`. |
| `agent in ["claude", "pi"]` | The value is one of these. |
| `machine.hostname matches "build-*"` | The value fits the pattern. `*` stands for any text, `?` for any one character. Capital letters count. |
| `work_email` | The Machine has this Variable, and it isn't empty. |

### Combining checks

- `&&` means "and": both sides must be true.
- `||` means "or": at least one side must be true.
- `!` means "not": `!(agent == "pi")` is true for every agent except `pi`.
- Use parentheses to group checks. Without them, `&&` comes before `||`, so `a || b && c` means `a || (b && c)`.

```md
{{if work_email && !(agent in ["codex"])}}
Commit as {{work_email}}.
{{end}}
```

### More than two cases

Add `{{else if …}}` for each extra case. The first one that's true is used, and the rest are skipped:

```md
{{if machine.os == "macos"}}
Install packages with brew.
{{else if machine.os == "linux" && machine.hostname matches "*-ci-*"}}
This is a CI runner. Don't install anything.
{{else if machine.os == "linux"}}
Install packages with apt.
{{else}}
Install packages with winget.
{{end}}
```

- `{{else if}}` and `{{else}}` are optional, and you can put blocks inside other blocks.
- A line that holds only `{{if …}}`, `{{else if …}}`, `{{else}}` or `{{end}}` disappears completely, so blocks don't leave blank lines behind.

## Writing a literal `{{`

Put a backslash in front: `\{{` renders as `{{`. Expressions are filled in everywhere, including inside code blocks, so escaping is the only way to keep `{{` as it is.

## Errors

A malformed Expression stops the Template from saving. The editor shows where the problem is, and for common slips, like writing `and` instead of `&&`, what to write instead. The preview keeps showing the last version that parsed while you fix it.
