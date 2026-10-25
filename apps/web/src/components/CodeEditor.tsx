import { useId, useRef, useState } from 'react';

export interface LineMark {
  line: number;
  kind: 'error' | 'warning';
  message: string;
}

/** Something the editor can suggest inside `{{ }}`, such as a Built-in Variable. */
export interface Suggestion {
  name: string;
  description: string;
}

/** The variable being typed at the caret: inside `{{` (a substitution) or after `{{if ` (a condition). */
interface Completion {
  query: string;
  /** Where the typed part starts. */
  from: number;
  condition: boolean;
}

/** An unescaped `{{`, optionally `if`, then the start of a name, right before the caret. */
const OPEN_EXPRESSION = /(\\?)\{\{\s*(?:(if)\s+)?([A-Za-z_][\w.]*)?$/;

function completionAt(value: string, caret: number): Completion | null {
  const match = OPEN_EXPRESSION.exec(value.slice(0, caret));
  if (!match || match[1]) return null;
  const query = match[3] ?? '';
  return { query, from: caret - query.length, condition: !!match[2] };
}

/** Replace the textarea's `from`–`to` with `text` the way typing would, so undo still works. */
function insert(textarea: HTMLTextAreaElement, from: number, to: number, text: string, onChange: (value: string) => void) {
  textarea.focus();
  textarea.setSelectionRange(from, to);
  if (!document.execCommand('insertText', false, text)) {
    onChange(textarea.value.slice(0, from) + text + textarea.value.slice(to));
    requestAnimationFrame(() => textarea.setSelectionRange(from + text.length, from + text.length));
  }
}

/**
 * A plain textarea with a line-number gutter. Marked lines are highlighted in the gutter.
 * Lines don't wrap, so gutter numbers stay aligned with the text. With `suggestions`, typing
 * `{{` or `{{if ` offers them, and an "Insert Variable" menu lists them too.
 */
export function CodeEditor({ value, onChange, marks = [], label, rows = 20, readOnly = false, suggestions = [] }: {
  value: string;
  onChange: (value: string) => void;
  marks?: LineMark[];
  label: string;
  rows?: number;
  readOnly?: boolean;
  suggestions?: readonly Suggestion[];
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const lineCount = value.split('\n').length;
  const markAt = new Map(marks.map((mark) => [mark.line, mark]));

  const enabled = suggestions.length > 0 && !readOnly;
  const completion = enabled && caret !== null ? completionAt(value, caret) : null;
  const key = completion ? `${completion.from}:${completion.query}` : null;
  const matches = completion ? suggestions.filter((s) => s.name.startsWith(completion.query)) : [];
  const open = !!completion && matches.length > 0 && dismissed !== key;
  const current = Math.min(active, matches.length - 1);

  const accept = (suggestion: Suggestion) => {
    if (!completion || !textarea.current || caret === null) return;
    const closed = /^\s*\}\}/.test(value.slice(caret));
    insert(textarea.current, completion.from, caret, suggestion.name + (completion.condition || closed ? '' : '}}'), onChange);
    setActive(0);
    // The caret may still sit right after the inserted name; don't offer it again there.
    setDismissed(`${completion.from}:${suggestion.name}`);
  };

  const insertVariable = (name: string) => {
    if (!textarea.current) return;
    const { selectionStart, selectionEnd } = textarea.current;
    insert(textarea.current, selectionStart, selectionEnd, `{{${name}}}`, onChange);
  };

  return (
    <div className="code-editor-wrap">
      {enabled ? (
        <div className="code-editor-tools">
          <select aria-label="Insert Variable" value="" onChange={(event) => event.target.value && insertVariable(event.target.value)}>
            <option value="">Insert Variable…</option>
            {suggestions.map((s) => (
              <option key={s.name} value={s.name}>{s.name} — {s.description}</option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="code-editor" style={{ '--rows': rows } as React.CSSProperties}>
        <div className="gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => {
            const mark = markAt.get(i + 1);
            return (
              <div key={i} className={mark ? `gutter-line ${mark.kind}` : 'gutter-line'} title={mark?.message}>
                {i + 1}
              </div>
            );
          })}
        </div>
        <textarea
          ref={textarea}
          aria-label={label}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onBlur={() => setCaret(null)}
          onKeyDown={(event) => {
            if (!open) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((current + step + matches.length) % matches.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              accept(matches[current]!);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setDismissed(key);
            }
          }}
          onScroll={(event) => {
            if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
          }}
          wrap="off"
          spellCheck={false}
          readOnly={readOnly}
          {...(enabled
            ? {
                role: 'combobox',
                'aria-autocomplete': 'list' as const,
                'aria-expanded': open,
                'aria-controls': listId,
                ...(open ? { 'aria-activedescendant': `${listId}-${current}` } : {}),
              }
            : {})}
        />
      </div>
      {open ? (
        <ul className="suggestions" id={listId} role="listbox" aria-label="Built-in Variables">
          {matches.map((s, i) => (
            <li
              key={s.name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              className={i === current ? 'suggestion active' : 'suggestion'}
              // Keep focus (and the caret) in the textarea while choosing.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(s)}
              onMouseEnter={() => setActive(i)}
            >
              <code>{s.name}</code> <span className="muted">{s.description}</span>
            </li>
          ))}
          <li className="suggestion-hint muted" aria-hidden="true">↑↓ to choose · Enter to insert · Esc to close</li>
        </ul>
      ) : null}
    </div>
  );
}
