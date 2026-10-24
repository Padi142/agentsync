# @agentsync/template

The Expression grammar for AgentSync Templates. It is the only place the syntax
lives: the CLI uses it to Render Targets, the web editor for preview and error
markers, and the server to validate saves and Conflict resolutions. It has no
runtime dependencies and runs in Node, Workers, and the browser.

## Grammar (v1)

| Syntax | Meaning |
|---|---|
| `{{editor}}` | A Machine Variable. Missing renders as empty, with a warning. |
| `{{machine.name}}`, `{{machine.os}}`, `{{agent}}` | Built-in Variables. |
| `{{if name == "value"}} … {{else}} … {{end}}` | A conditional. `!=` also works, blocks nest, `else` is optional. |
| `\{{` | A literal `{{`. |

- Whitespace inside `{{ … }}` is ignored. A quoted value may contain `}}` or `{{`.
- A line that contains only a block tag (`if`, `else`, or `end`), plus optional
  spaces or tabs, is removed together with its line break. This is part of the
  grammar, so blocks don't leave blank lines in the output.
- `{{if}}` blocks can be nested up to 64 deep. A deeper `{{if}}` is a syntax
  error.
- `\{{` disables substitution: the backslash is dropped and the Expression is
  kept as literal text. In `C:\Users\{{machine.name}}` the output is
  `C:\Users{{machine.name}}`, not the Machine's name.
- Expressions are evaluated everywhere, including inside Markdown code fences.
  Escaping is the only way to keep `{{` literal.
- Malformed syntax is a hard error with a line and column. An unknown
  `machine.*` name such as `{{machine.arch}}` is a hard error too, so typos are
  caught when the Template is saved. There is no `and`/`or`, no loops, and no
  filters.
- Lines and columns are 1-based. Columns count UTF-16 code units (JavaScript
  string indices), as most editors do, so an emoji counts as two columns.
- Users cannot set Variables named `agent`, `machine`, or `machine.*`, or named
  after a keyword.

## Interface

```ts
render(template, { variables, builtins: { machine: { name, os }, agent } });
// → { text, warnings }; throws TemplateSyntaxError if malformed
validate(template); // → { line, column, message } | null
referencedVariables(template); // → Machine Variable names used in any branch
hasConflictMarkers(text); // → true if <<<<<<< / ||||||| / >>>>>>> lines remain
suspectedConflictMarkers(text); // → lines that are exactly =======
isSettableVariableName(name);
```

Render once per Target: `agent` differs from one Target to the next.

When resolving a Conflict, `hasConflictMarkers` must be false. A leftover
`=======` separator looks exactly like a Markdown heading underline, so
`suspectedConflictMarkers` reports those lines separately. Use it to warn, not to
block.

## Building

The package exports `dist/` (JS and `.d.ts`), so plain `tsc` consumers with
`NodeNext` can import it. Run `pnpm --filter @agentsync/template build` after
changing `src/`. The root `build` and `typecheck` scripts do this first.
