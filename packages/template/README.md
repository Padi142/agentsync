# @agentsync/template

The Expression grammar for AgentSync Templates. It is the only place the syntax
lives: the CLI uses it to Render Targets, the web editor for preview and error
markers, and the server to validate saves and Conflict resolutions. It has no
runtime dependencies and runs in Node, Workers, and the browser.

## Grammar

| Syntax | Meaning |
|---|---|
| `{{editor}}` | A Machine Variable. Missing renders as empty, with a warning. |
| `{{editor ?? "vim"}}` | A default, rendered when the Variable is missing or empty, without a warning. |
| `{{machine.nickname}}`, `{{machine.hostname}}`, `{{machine.os}}`, `{{agent}}` | Built-in Variables. The nickname is the editable name a person gives the Machine; the hostname is the computer's own. `BUILTIN_VARIABLES` lists them with descriptions for editors. |
| `{{if name == "value"}} … {{else if name != "value"}} … {{else}} … {{end}}` | A conditional. The first branch whose condition holds renders. `else if` and `else` are optional, blocks nest. |
| `a == "x"`, `a != "x"` | Tests in a condition: the Variable equals, or doesn't equal, the value. |
| `a in ["x", "y"]` | Equals one of the values. A trailing comma is allowed. |
| `a matches "build-*"` | Matches a glob over the whole value: `*` is any run of characters, `?` is one. Everything else is literal, and matching is case-sensitive. |
| `a` | Is set to a non-empty value. Built-in Variables are always set, so testing one alone is an error. |
| `a == "x" && (b \|\| !(c in ["z"]))` | Tests joined with `&&` and `\|\|`, negated with `!`, grouped with parentheses. `&&` binds tighter than `\|\|`. |
| `\{{` | A literal `{{`. |

- Whitespace inside `{{ … }}` is ignored. A quoted value may contain `}}` or `{{`.
- A line that contains only a block tag (`if`, `else if`, `else`, or `end`), plus optional
  spaces or tabs, is removed together with its line break. This is part of the
  grammar, so blocks don't leave blank lines in the output.
- `{{if}}` blocks can be nested up to 64 deep, and so can `!` and parentheses
  within a condition. Deeper is a syntax error. `{{else if}}` adds no depth.
- Conditions short-circuit: a Variable whose test can't change the result is not
  looked up, so it can't produce a missing-variable warning. A bare name test
  never warns, nor does a substitution with a default.
- An empty value counts as no value for a bare name test and for `??`, as in
  `${x:-default}`. `==` still compares it as `""`.
- `\{{` disables substitution: the backslash is dropped and the Expression is
  kept as literal text. In `C:\Users\{{machine.hostname}}` the output is
  `C:\Users{{machine.hostname}}`, not the hostname.
- Expressions are evaluated everywhere, including inside Markdown code fences.
  Escaping is the only way to keep `{{` literal.
- Malformed syntax is a hard error with a line and column. An unknown
  `machine.*` name such as `{{machine.arch}}` is a hard error too, so typos are
  caught when the Template is saved. There are no loops and no filters.
- Errors inside a condition point at the offending token, and a missing-variable
  warning points at the Variable's name.
- Lines and columns are 1-based. Columns count UTF-16 code units (JavaScript
  string indices), as most editors do, so an emoji counts as two columns.
- Users cannot set Variables named `agent`, `machine`, or `machine.*`, or named
  after a keyword.
- Templates using `&&`, `||`, `!`, parentheses, `in`, `matches`, bare name
  tests, `??` or `{{else if}}` need a CLI built from this version. An older one
  reports a syntax error and writes nothing.

## Interface

```ts
render(template, { variables, builtins: { machine: { hostname, nickname, os }, agent } });
// → { text, warnings }; throws TemplateSyntaxError if malformed
render(template, context, { mark: (value, name) => `<${value}>` });
// wraps each substituted value, e.g. to highlight it in a preview; conditions still compare the bare value
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
