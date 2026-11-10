export interface RenderContext {
  variables: Record<string, string>;
  builtins: { machine: { hostname: string; nickname: string; os: string }; agent: string };
}

/** A 1-based line and column in the Template source. */
export interface Position {
  line: number;
  column: number;
}

export interface RenderWarning extends Position {
  kind: 'missing-variable';
  variable: string;
  message: string;
}

export interface RenderResult {
  text: string;
  warnings: RenderWarning[];
}

export interface RenderOptions {
  /**
   * Wraps the text each substitution produces, e.g. to highlight it in a preview.
   * Conditions still compare the bare value, and a missing Variable's empty text is not wrapped.
   */
  mark?: (value: string, name: string) => string;
}

export function render(template: string, context: RenderContext, options: RenderOptions = {}): RenderResult {
  const warnings: RenderWarning[] = [];
  const resolve = (reference: Reference): string => {
    const value = lookup(reference.name, context);
    if (value !== undefined) return value;
    warnings.push({
      kind: 'missing-variable',
      variable: reference.name,
      line: reference.line,
      column: reference.column,
      message: `Variable "${reference.name}" is not set on this Machine`,
    });
    return '';
  };
  // `every`, `some` and `find` stop early, so a Variable that decides nothing isn't looked up or warned about.
  const holds = (condition: Condition): boolean => {
    switch (condition.type) {
      case 'compare':
        return (resolve(condition) === condition.value) === (condition.operator === '==');
      case 'in':
        return condition.values.includes(resolve(condition));
      case 'matches':
        return condition.pattern.test(resolve(condition));
      case 'set':
        return (lookup(condition.name, context) ?? '') !== '';
      case 'not':
        return !holds(condition.operand);
      case 'all':
        return condition.operands.every(holds);
      case 'any':
        return condition.operands.some(holds);
    }
  };
  const renderNodes = (nodes: Node[]): string =>
    nodes
      .map((node) => {
        if (node.type === 'text') return node.value;
        if (node.type === 'variable') {
          const value = node.fallback === undefined ? resolve(node) : (lookup(node.name, context) || node.fallback);
          return options.mark && value ? options.mark(value, node.name) : value;
        }
        const branch = node.branches.find((candidate) => holds(candidate.condition));
        return renderNodes(branch ? branch.body : node.else);
      })
      .join('');
  return { text: renderNodes(parse(template)), warnings };
}

export interface TemplateError extends Position {
  message: string;
}

/** Thrown by `render` when the Template is malformed. Nothing is rendered. */
export class TemplateSyntaxError extends Error implements TemplateError {
  readonly line: number;
  readonly column: number;

  constructor(message: string, position: Position) {
    super(message);
    this.name = 'TemplateSyntaxError';
    this.line = position.line;
    this.column = position.column;
  }
}

/** Checks syntax only. Returns the first error, or null if the Template is well-formed. */
export function validate(template: string): TemplateError | null {
  try {
    parse(template);
    return null;
  } catch (error) {
    if (!(error instanceof TemplateSyntaxError)) throw error;
    return { line: error.line, column: error.column, message: error.message };
  }
}

/**
 * The Machine Variables a Template uses in any branch, in order of first use.
 * Built-in Variables are excluded. Throws a TemplateSyntaxError if the Template is malformed.
 */
export function referencedVariables(template: string): string[] {
  const names = new Set<string>();
  const add = (name: string) => {
    if (!isBuiltin(name)) names.add(name);
  };
  const visitCondition = (condition: Condition): void => {
    if (condition.type === 'not') visitCondition(condition.operand);
    else if ('operands' in condition) condition.operands.forEach(visitCondition);
    else add(condition.name);
  };
  const visit = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (node.type === 'variable') add(node.name);
      if (node.type !== 'if') continue;
      for (const branch of node.branches) {
        visitCondition(branch.condition);
        visit(branch.body);
      }
      visit(node.else);
    }
  };
  visit(parse(template));
  return [...names];
}

/**
 * True if the text still contains git-style Conflict markers (`<<<<<<<`, `|||||||`, `>>>>>>>`).
 * A leftover `=======` separator is reported by `suspectedConflictMarkers` instead.
 */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|\|{7}|>{7})(?![<|>])/m.test(text);
}

/**
 * The 1-based lines that are exactly `=======`: possibly a leftover Conflict separator, but
 * indistinguishable from a Markdown heading underline, so callers should warn, not block.
 */
export function suspectedConflictMarkers(text: string): number[] {
  return text
    .split('\n')
    .flatMap((line, i) => (/^={7}\r?$/.test(line) ? [i + 1] : []));
}

/** True if users may set a Machine Variable with this name: not reserved, and referenceable. */
export function isSettableVariableName(name: string): boolean {
  return (
    NAME.test(name) && !KEYWORDS.includes(name) && !RESERVED.includes(name)
  );
}

const RESERVED = ['agent', 'machine'];

/** A Built-in Variable: what it means, for editors, and how it is read from the Render context. */
export interface BuiltinVariable {
  name: string;
  description: string;
  read(builtins: RenderContext['builtins']): string;
}

/** Every Built-in Variable. Editors suggest these; the engine accepts exactly these. */
export const BUILTIN_VARIABLES: readonly BuiltinVariable[] = [
  {
    name: 'machine.nickname',
    description: 'The Machine nickname, editable on the web or with agentsync rename',
    read: (builtins) => builtins.machine.nickname,
  },
  {
    name: 'machine.hostname',
    description: "The computer's hostname, as AgentSync last saw it",
    read: (builtins) => builtins.machine.hostname,
  },
  {
    name: 'machine.os',
    description: 'Operating system: linux, macos, or windows',
    read: (builtins) => builtins.machine.os,
  },
  {
    name: 'agent',
    description: 'The agent a Target belongs to, such as claude, codex, pi or opencode',
    read: (builtins) => builtins.agent,
  },
];

const builtin = (name: string) =>
  BUILTIN_VARIABLES.find((variable) => variable.name === name);

const isBuiltin = (name: string) => builtin(name) !== undefined;

function lookup(name: string, context: RenderContext): string | undefined {
  const found = builtin(name);
  if (found) return found.read(context.builtins);
  if (Object.hasOwn(context.variables, name)) return context.variables[name];
  return undefined;
}

type Reference = { name: string } & Position;

/**
 * What an `{{if}}` tests: tests of one Variable (`==`, `!=`, `in`, `matches`, or a bare name for
 * "is set"), combined with `&&`, `||` and `!`, grouped with parentheses.
 */
type Condition =
  | ({ type: 'compare'; operator: '==' | '!='; value: string } & Reference)
  | ({ type: 'in'; values: string[] } & Reference)
  | ({ type: 'matches'; pattern: RegExp } & Reference)
  /** A bare name: the Variable is set to a non-empty value. */
  | ({ type: 'set' } & Reference)
  | { type: 'not'; operand: Condition }
  | { type: 'all' | 'any'; operands: Condition[] };

/** An `{{if}}` and its `{{else if}}`s: the first branch whose condition holds renders, or else `else`. */
type IfNode = {
  type: 'if';
  branches: { condition: Condition; body: Node[] }[];
  else: Node[];
} & Position;

/** A substitution. With a `fallback` (`{{name ?? "fallback"}}`), a missing or empty Variable renders it, without a warning. */
type VariableNode = { type: 'variable'; fallback: string | undefined } & Reference;

type Node = { type: 'text'; value: string } | VariableNode | IfNode;

const NAME = /^[A-Za-z_]\w*$/;
const KEYWORDS = ['if', 'else', 'end'];
// Bounds the recursion in render and referencedVariables, for nested blocks and nested conditions.
const MAX_NESTING = 64;
const TRAILING = /[ \t]*(\r?\n|$)/y;
/** Tags written the way other template languages spell them, and what to write instead. */
const TAG_HINTS: [RegExp, string][] = [
  [/^(elif|elsif|elseif)\b/, 'Use {{else if …}} instead'],
  [/^(endif|fi|\/if)$/, 'Use {{end}} instead'],
  [/^[\w.]+\s*\|\|/, 'Use ?? for a default, such as {{editor ?? "vim"}}'],
];
/** `name ?? "default"`. The name is checked separately, so a bad one gets the usual message. */
const DEFAULTED = /^(.*?)\s*\?\?\s*"([^"]*)"$/s;

function parse(source: string): Node[] {
  const root: Node[] = [];
  const open: { node: IfNode; inElse: boolean }[] = [];
  const push = (node: Node) => {
    const frame = open.at(-1);
    const nodes = !frame
      ? root
      : frame.inElse
        ? frame.node.else
        : frame.node.branches[frame.node.branches.length - 1]!.body;
    nodes.push(node);
  };
  // The scanner only moves forward, so positions are tracked incrementally to keep parsing linear.
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  const positionAt = (offset: number): Position => {
    for (; scanned < offset; scanned++) {
      if (source.charCodeAt(scanned) === 10) {
        line++;
        lineStart = scanned + 1;
      }
    }
    return { line, column: offset - lineStart + 1 };
  };
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('{{', index);
    if (start === -1) break;
    if (source[start - 1] === '\\') {
      push({ type: 'text', value: source.slice(index, start - 1) + '{{' });
      index = start + 2;
      continue;
    }
    const position = positionAt(start);
    const fail = (message: string): never => {
      throw new TemplateSyntaxError(message, position);
    };
    const end = closingDelimiter(source, start + 2);
    if (end === -1) fail('Unclosed Expression: add a matching }}');
    const tag = source.slice(start + 2, end).trim();
    // A block tag alone on its line takes the whole line with it, so it leaves no blank line.
    // If the line started before `index`, an earlier Expression shares it.
    TRAILING.lastIndex = end + 2;
    const trailing = TRAILING.exec(source);
    const standalone =
      /^(if|else|end)\b/.test(tag) &&
      lineStart >= index &&
      /^[ \t]*$/.test(source.slice(lineStart, start)) &&
      trailing !== null;
    push({
      type: 'text',
      value: source.slice(index, standalone ? lineStart : start),
    });
    index = standalone ? end + 2 + trailing![0].length : end + 2;
    const conditional = /^(else\s+)?if\b/.exec(tag);
    if (tag === '') {
      fail('Empty Expression');
    } else if (conditional) {
      // Where the trimmed tag starts in the source, so the condition can report its own positions.
      const tagStart = end - source.slice(start + 2, end).trimStart().length;
      const condition = parseCondition(source, tagStart + conditional[0].length, end, positionAt);
      if (conditional[1]) {
        const frame = open.at(-1) ?? fail('{{else if}} has no matching {{if}}');
        if (frame.inElse) fail('{{else if}} must come before {{else}}');
        frame.node.branches.push({ condition, body: [] });
        continue;
      }
      if (open.length === MAX_NESTING) {
        fail(`{{if}} blocks can only be nested ${MAX_NESTING} deep`);
      }
      const node: IfNode = { type: 'if', branches: [{ condition, body: [] }], else: [], ...position };
      push(node);
      open.push({ node, inElse: false });
    } else if (tag === 'else') {
      const frame = open.at(-1) ?? fail('{{else}} has no matching {{if}}');
      if (frame.inElse) fail('{{if}} can only have one {{else}}');
      frame.inElse = true;
    } else if (tag === 'end') {
      if (!open.pop()) fail('{{end}} has no matching {{if}}');
    } else {
      for (const [mistake, hint] of TAG_HINTS) if (mistake.test(tag)) fail(hint);
      const defaulted = tag.includes('??')
        ? (DEFAULTED.exec(tag) ?? fail('Malformed default: expected {{name ?? "default"}}'))
        : undefined;
      const name = defaulted?.[1] ?? tag;
      checkName(name, fail);
      push({ type: 'variable', name, fallback: defaulted?.[2], ...position });
    }
  }
  const unclosed = open.at(-1);
  if (unclosed) {
    throw new TemplateSyntaxError(
      'Unclosed {{if}}: add a matching {{end}}',
      unclosed.node,
    );
  }
  push({ type: 'text', value: source.slice(index) });
  return root;
}

type Token = {
  kind: 'name' | 'value' | '==' | '!=' | '&&' | '||' | '!' | '(' | ')' | '[' | ']' | ',';
  /** As written, quotes included. */
  text: string;
  at: Position;
};

const TOKEN = /([A-Za-z_][\w.]*)|("[^"]*")|(==|!=|&&|\|\||[!()[\],])/y;
/** What a stray character most likely meant. */
const STRAY_HINTS: Record<string, string> = {
  '=': ': compare with ==',
  '&': ': join conditions with &&',
  '|': ': join conditions with ||',
  "'": ': quote values with "',
  '*': ': quote a pattern, such as "build-*"',
  '~': ': match a pattern with matches, such as machine.hostname matches "build-*"',
  '?': ': a default only works in {{name ?? "default"}}',
};
/** A character that belongs to an unquoted value, such as linux-2 or 3. */
const UNQUOTED = /[\w\-./:@+]/;
/** Words people reach for instead of the operators. */
const SPELLED: Record<string, string> = { and: '&&', or: '||', not: '!' };

/** A glob for `matches`: `*` is any run of characters, `?` is one. It must match the whole value. */
function globPattern(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\*?]/g, (char) =>
    char === '*' ? '[^]*' : char === '?' ? '[^]' : `\\${char}`,
  );
  return new RegExp(`^${body}$`);
}

/**
 * Parses the condition between `from` and `to`. `&&` binds tighter than `||`, and `!` applies to
 * the test or parenthesized group right after it. Errors point at the offending token.
 */
function parseCondition(
  source: string,
  from: number,
  to: number,
  positionAt: (offset: number) => Position,
): Condition {
  const tokens: Token[] = [];
  for (let i = from; ; ) {
    while (i < to && /\s/.test(source.charAt(i))) i++;
    if (i >= to) break;
    const at = positionAt(i);
    TOKEN.lastIndex = i;
    const match = TOKEN.exec(source);
    if (!match || TOKEN.lastIndex > to) {
      const char = source.charAt(i);
      const hint = STRAY_HINTS[char] ?? (UNQUOTED.test(char) ? ': quote values, such as "linux"' : '');
      throw new TemplateSyntaxError(`Unexpected ${char} in a condition${hint}`, at);
    }
    const kind = match[1] !== undefined ? 'name' : match[2] !== undefined ? 'value' : (match[3] as Token['kind']);
    tokens.push({ kind, text: match[0], at });
    i = TOKEN.lastIndex;
  }
  const end = positionAt(to);
  let next = 0;
  const peek = (): Token | undefined => tokens[next];
  function fail(message: string, token = peek()): never {
    throw new TemplateSyntaxError(message, token?.at ?? end);
  }
  const spelledOut = (token: Token | undefined) =>
    token && Object.hasOwn(SPELLED, token.text) ? `Use ${SPELLED[token.text]} instead of ${token.text}` : null;
  /** Takes a quoted value, or fails saying what it follows. */
  function value(after: string): string {
    const token = peek();
    if (token?.kind !== 'value') fail(`Expected a quoted value after ${after}, such as "linux"`);
    next++;
    return token.text.slice(1, -1);
  }

  function joined(type: 'all' | 'any', operator: '&&' | '||', operand: () => Condition): Condition {
    const first = operand();
    const operands = [first];
    while (peek()?.kind === operator) {
      next++;
      operands.push(operand());
    }
    return operands.length === 1 ? first : { type, operands };
  }
  const either = (depth: number) => joined('any', '||', () => both(depth));
  const both = (depth: number) => joined('all', '&&', () => single(depth));

  function single(depth: number): Condition {
    if (depth === MAX_NESTING) fail(`Conditions can only be nested ${MAX_NESTING} deep`);
    const token = peek();
    next++;
    if (token?.kind === '!') return { type: 'not', operand: single(depth + 1) };
    if (token?.kind === '(') {
      const inner = either(depth + 1);
      const close = peek();
      if (!close) fail('Unclosed (: add a matching )', token);
      if (close.kind !== ')') fail(spelledOut(close) ?? `Expected &&, || or ) before ${close.text}`);
      next++;
      return inner;
    }
    if (token?.kind !== 'name') fail('Expected a condition such as agent == "claude"', token);
    const reference = { name: token.text, ...token.at };
    const operator = peek();
    // `not editor` reads like a test of `not`; say what was meant instead.
    if (spelledOut(token) && (operator?.kind === 'name' || operator?.kind === '(' || operator?.kind === '!')) {
      fail(spelledOut(token)!, token);
    }
    checkName(token.text, (message) => fail(message, token));
    if (operator?.kind === '==' || operator?.kind === '!=') {
      next++;
      return { type: 'compare', operator: operator.kind, value: value(operator.kind), ...reference };
    }
    if (operator?.text === 'matches') {
      next++;
      return { type: 'matches', pattern: globPattern(value('matches')), ...reference };
    }
    if (operator?.text === 'in') {
      next++;
      if (peek()?.kind !== '[') fail('Expected a list after in, such as ["claude", "pi"]');
      next++;
      const values = [value('[')];
      while (peek()?.kind === ',') {
        next++;
        // A trailing comma is fine, so a long list can keep one value per line.
        if (peek()?.kind === ']') break;
        values.push(value('the comma'));
      }
      if (peek()?.kind !== ']') fail(peek() ? `Expected , or ] before ${peek()!.text}` : 'Unclosed [: add a matching ]');
      next++;
      return { type: 'in', values, ...reference };
    }
    if (operator?.text === 'not') {
      fail(`Put ! in front instead: !(${token.text} ${tokens[next + 1]?.text ?? 'in'} …)`, operator);
    }
    if (operator?.kind === 'value' || (operator?.kind === 'name' && !spelledOut(operator))) {
      fail(`Expected ==, !=, in or matches before ${operator.text}`);
    }
    if (isBuiltin(token.text)) {
      fail(`Built-in Variables are always set: compare ${token.text} with == or != instead`, token);
    }
    return { type: 'set', ...reference };
  }

  const condition = either(0);
  const extra = peek();
  if (extra) {
    fail(
      extra.kind === ')'
        ? 'Unexpected ): it has no matching ('
        : spelledOut(extra) ?? `Expected && or || before ${extra.text}`,
    );
  }
  return condition;
}

/** The index of the `}}` that closes an Expression, skipping any inside a quoted value; -1 if none. */
function closingDelimiter(source: string, from: number): number {
  let quoted = false;
  for (let i = from; i < source.length - 1; i++) {
    if (source[i] === '"') quoted = !quoted;
    else if (!quoted && source[i] === '}' && source[i + 1] === '}') return i;
  }
  return -1;
}

function checkName(name: string, fail: (message: string) => never): void {
  if (isBuiltin(name)) return;
  if (name === 'machine' || name.startsWith('machine.')) {
    fail(`Unknown Built-in Variable "${name}"`);
  }
  if (!isSettableVariableName(name)) fail(`Invalid Variable name "${name}"`);
}
