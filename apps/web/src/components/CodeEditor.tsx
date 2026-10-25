import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
 * Display-only highlighting: Expressions, escapes and the Markdown punctuation that gives a line
 * its shape. Validation is the grammar's job; this only has to look right while typing.
 */
const TOKEN = /(\\\{\{)|(\{\{\s*(?:if\b|else\b|end\b)(?:[^}"]|"[^"]*"|\}(?!\}))*\}\})|(\{\{(?:[^}"]|"[^"]*"|\}(?!\}))*\}\})|^(#{1,6})(?=\s|$)|^(\s*(?:[-*+]|\d+[.)]))(?=\s)|^(\s*>)|^(\s*(?:```|~~~).*)$/g;
const CLASSES = ['', 'tok-escape', 'tok-block', 'tok-expression', 'tok-punct', 'tok-punct', 'tok-punct', 'tok-fence'];
const CONFLICT_MARKER = /^(<{7}|={7}$|>{7}|\|{7})/;

export function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(TOKEN)) {
    const group = match.findIndex((part, i) => i > 0 && part !== undefined);
    const start = match.index + match[0].indexOf(match[group]!);
    if (start > cursor) out.push(line.slice(cursor, start));
    out.push(<span key={start} className={CLASSES[group]}>{match[group]}</span>);
    cursor = start + match[group]!.length;
  }
  if (cursor < line.length) out.push(line.slice(cursor));
  return out;
}

/**
 * A Template editor: a transparent textarea over a highlighted copy of its text. Both wrap the
 * same way and the textarea is sized by the copy, so the editor grows with its content and the
 * page does all the scrolling. Line numbers sit beside each logical line, wrapped or not.
 * With `suggestions`, typing `{{` or `{{if ` offers them at the caret.
 */
export function CodeEditor({ value, onChange, marks = [], label, readOnly = false, suggestions = [], toolbar, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  marks?: LineMark[];
  label: string;
  readOnly?: boolean;
  suggestions?: readonly Suggestion[];
  /** Shown in the editor's header row, on the left. */
  toolbar?: ReactNode;
  placeholder?: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const caretMarker = useRef<HTMLSpanElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [popup, setPopup] = useState<{ top: number; left: number } | null>(null);
  const lines = value.split('\n');
  const markAt = new Map(marks.map((mark) => [mark.line, mark]));

  const enabled = suggestions.length > 0 && !readOnly;
  const completion = enabled && caret !== null ? completionAt(value, caret) : null;
  const key = completion ? `${completion.from}:${completion.query}` : null;
  const matches = completion ? suggestions.filter((s) => s.name.startsWith(completion.query)) : [];
  const open = !!completion && matches.length > 0 && dismissed !== key;
  const current = Math.min(active, matches.length - 1);

  // Place the suggestions under the caret, measured from a hidden copy of the text before it.
  useLayoutEffect(() => {
    const marker = caretMarker.current;
    if (!open || !marker) return setPopup(null);
    const width = marker.offsetParent?.clientWidth ?? 0;
    setPopup({ top: marker.offsetTop + marker.offsetHeight + 4, left: Math.max(0, Math.min(marker.offsetLeft - 8, width - 340)) });
  }, [open, caret, value]);

  const accept = (suggestion: Suggestion) => {
    if (!completion || !textarea.current || caret === null) return;
    // Replace the whole name, including any part after the caret, so no old suffix is left behind.
    const to = caret + (/^[\w.]*/.exec(value.slice(caret))?.[0].length ?? 0);
    const closed = /^\s*\}\}/.test(value.slice(to));
    insert(textarea.current, completion.from, to, suggestion.name + (completion.condition || closed ? '' : '}}'), onChange);
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
    <div className="editor-frame" data-readonly={readOnly || undefined}>
      {toolbar || enabled ? (
        <div className="editor-head">
          <div className="editor-head-start">{toolbar}</div>
          {enabled ? (
            <select className="select small" aria-label="Insert Variable" value=""
              onChange={(event) => event.target.value && insertVariable(event.target.value)}>
              <option value="">Insert Variable</option>
              {suggestions.map((s) => (
                <option key={s.name} value={s.name}>{s.name}: {s.description}</option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}
      <div className="editor" style={{ '--digits': String(lines.length).length } as React.CSSProperties}>
        <div className="editor-backdrop" aria-hidden="true">
          {lines.map((line, i) => {
            const mark = markAt.get(i + 1);
            const conflict = CONFLICT_MARKER.test(line);
            const className = ['editor-line', mark && `is-${mark.kind}`, conflict && 'is-conflict'].filter(Boolean).join(' ');
            return <div key={i} className={className} data-n={i + 1}>{highlight(line)}</div>;
          })}
        </div>
        {open ? (
          <div className="editor-measure" aria-hidden="true">
            {value.slice(0, caret ?? 0)}<span ref={caretMarker}>{'​'}</span>
          </div>
        ) : null}
        <textarea
          ref={textarea}
          className="editor-input"
          aria-label={label}
          value={value}
          placeholder={placeholder}
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
            } else if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              accept(matches[current]!);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setDismissed(key);
            }
          }}
          // The backdrop sizes the textarea, so it never needs to scroll. Undo any scroll a browser starts anyway.
          onScroll={(event) => { event.currentTarget.scrollTop = 0; }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
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
        {open ? (
          <ul className="suggestions" id={listId} role="listbox" aria-label="Built-in Variables"
            style={popup ? { top: popup.top, left: popup.left } : { visibility: 'hidden' }}>
            {matches.map((s, i) => (
              <li
                key={s.name}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                className="suggestion"
                // Keep focus (and the caret) in the textarea while choosing.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => accept(s)}
                onMouseEnter={() => setActive(i)}
              >
                <code>{s.name}</code>
                <span>{s.description}</span>
              </li>
            ))}
            <li className="suggestion-hint" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> choose <kbd>Enter</kbd> insert <kbd>Esc</kbd> close</li>
          </ul>
        ) : null}
      </div>
    </div>
  );
}
