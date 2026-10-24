export interface RenderContext {
  variables: Record<string, string>;
  builtins: { machine: { name: string; os: string }; agent: string };
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

export function render(template: string, context: RenderContext): RenderResult {
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
  const renderNodes = (nodes: Node[]): string =>
    nodes
      .map((node) => {
        if (node.type === 'text') return node.value;
        if (node.type === 'variable') return resolve(node);
        const equal = resolve(node) === node.value;
        return renderNodes(
          equal === (node.operator === '==') ? node.then : node.else,
        );
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
  const visit = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.type === 'text') continue;
      if (!isBuiltin(node.name)) names.add(node.name);
      if (node.type === 'if') {
        visit(node.then);
        visit(node.else);
      }
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

const BUILTINS = ['agent', 'machine.name', 'machine.os'] as const;

const isBuiltin = (name: string) =>
  (BUILTINS as readonly string[]).includes(name);

function lookup(name: string, context: RenderContext): string | undefined {
  const { machine, agent } = context.builtins;
  const builtins: Record<(typeof BUILTINS)[number], string> = {
    agent,
    'machine.name': machine.name,
    'machine.os': machine.os,
  };
  if (Object.hasOwn(builtins, name))
    return builtins[name as keyof typeof builtins];
  if (Object.hasOwn(context.variables, name)) return context.variables[name];
  return undefined;
}

type Reference = { name: string } & Position;

type IfNode = {
  type: 'if';
  operator: '==' | '!=';
  value: string;
  then: Node[];
  else: Node[];
} & Reference;

type Node =
  { type: 'text'; value: string } | ({ type: 'variable' } & Reference) | IfNode;

const IF = /^if\s+([\w.]+)\s*(==|!=)\s*"([^"]*)"$/;
const NAME = /^[A-Za-z_]\w*$/;
const KEYWORDS = ['if', 'else', 'end'];
// Bounds the recursion in render and referencedVariables.
const MAX_NESTING = 64;
const TRAILING = /[ \t]*(\r?\n|$)/y;

function parse(source: string): Node[] {
  const root: Node[] = [];
  const open: { node: IfNode; inElse: boolean }[] = [];
  const push = (node: Node) => {
    const frame = open.at(-1);
    (frame ? (frame.inElse ? frame.node.else : frame.node.then) : root).push(
      node,
    );
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
      /^(if|else|end)(\s|$)/.test(tag) &&
      lineStart >= index &&
      /^[ \t]*$/.test(source.slice(lineStart, start)) &&
      trailing !== null;
    push({
      type: 'text',
      value: source.slice(index, standalone ? lineStart : start),
    });
    index = standalone ? end + 2 + trailing![0].length : end + 2;
    if (tag === '') {
      fail('Empty Expression');
    } else if (/^if(\s|$)/.test(tag)) {
      const [, name, operator, value] =
        IF.exec(tag) ??
        fail(
          'Malformed {{if}}: expected {{if name == "value"}} or {{if name != "value"}}',
        );
      checkName(name, fail);
      if (open.length === MAX_NESTING) {
        fail(`{{if}} blocks can only be nested ${MAX_NESTING} deep`);
      }
      const node: IfNode = {
        type: 'if',
        name,
        operator: operator as IfNode['operator'],
        value,
        then: [],
        else: [],
        ...position,
      };
      push(node);
      open.push({ node, inElse: false });
    } else if (tag === 'else') {
      const frame = open.at(-1) ?? fail('{{else}} has no matching {{if}}');
      if (frame.inElse) fail('{{if}} can only have one {{else}}');
      frame.inElse = true;
    } else if (tag === 'end') {
      if (!open.pop()) fail('{{end}} has no matching {{if}}');
    } else {
      checkName(tag, fail);
      push({ type: 'variable', name: tag, ...position });
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
