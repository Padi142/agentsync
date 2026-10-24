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

- Whitespace inside `{{ … }}` is ignored.
- A block tag (`if`, `else`, `end`) alone on its line removes that whole line,
  so blocks don't leave blank lines in the output.
- Expressions are evaluated everywhere, including inside Markdown code fences.
  Escaping is the only way to keep `{{` literal.
- Malformed syntax is a hard error with a line and column. This includes an
  unknown `machine.*` name. There is no `and`/`or`, no loops, and no filters.
- Users cannot set Variables named `agent`, `machine`, or `machine.*`, or named
  after a keyword.

## Interface

```ts
render(template, { variables, builtins: { machine: { name, os }, agent } });
// → { text, warnings }; throws TemplateSyntaxError if malformed
validate(template); // → { line, column, message } | null
referencedVariables(template); // → Machine Variable names used in any branch
hasConflictMarkers(text); // → true if <<<<<<< / ||||||| / >>>>>>> lines remain
isSettableVariableName(name);
```

Render once per Target: `agent` differs from one Target to the next.
