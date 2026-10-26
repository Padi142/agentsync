import { BUILTIN_VARIABLES } from '@agentsync/template';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { Suggestion } from './CodeEditor';
import { Icon } from './Icon';

/** Something a click can write into the Template: `before` and `after` go around the selection. */
export interface Insertable {
  group: string;
  /** How it reads in the Template. */
  expression: string;
  description: string;
  before: string;
  after?: string;
}

/** What a condition can compare each Variable with, by Variable name. Its keys are every Variable. */
export type ConditionValues = Readonly<Record<string, readonly Suggestion[]>>;

const LITERAL: Insertable = { group: 'Escape', expression: '\\{{', description: 'A literal {{.', before: '\\{{' };

/** Every Variable as an Insertable, in the order the menu and the palette show them. */
export function insertables(own: readonly Suggestion[] = []): Insertable[] {
  const variable = (group: string) => ({ name, description }: Suggestion): Insertable =>
    ({ group, expression: `{{${name}}}`, description, before: `{{${name}}}` });
  return [...BUILTIN_VARIABLES.map(variable('Built-in')), ...own.map(variable('Your Variables'))];
}

function grouped(items: readonly Insertable[]) {
  return [...new Set(items.map((item) => item.group))].map((group) => ({
    group,
    items: items.filter((item) => item.group === group),
  }));
}

interface InsertProps {
  items: readonly Insertable[];
  values: ConditionValues;
  onInsert: (insert: { before: string; after?: string }) => void;
  disabled?: boolean;
}

/** A header button that opens every Insertable, grouped, like the `{{` suggestions, and the condition builder. */
export function InsertMenu({ items, values, onInsert, disabled }: InsertProps) {
  const [view, setView] = useState<'menu' | 'condition' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  const menuItems = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!view) return;
    // The first item, or the condition's first control.
    root.current?.querySelector<HTMLElement>('[role="menuitem"], .insert-popover select')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setView(null);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [view]);

  const close = () => {
    setView(null);
    button.current?.focus();
  };
  const insert = (value: { before: string; after?: string }) => {
    setView(null);
    onInsert(value);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (view !== 'menu') return;
    const all = menuItems();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      event.preventDefault();
      all[(i + all.length) % all.length]?.focus();
    };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(-1);
    else if (event.key === 'Tab') setView(null);
  };

  const option = (item: Insertable) => (
    <button key={item.expression} type="button" role="menuitem" tabIndex={-1} className="insert-option"
      onClick={() => insert(item)}>
      <code>{item.expression}</code>
      <span>{item.description}</span>
    </button>
  );

  return (
    <div className="insert-menu" ref={root} onKeyDown={view ? onKeyDown : undefined}>
      <button ref={button} type="button" className="button secondary small" disabled={disabled}
        aria-haspopup={view === 'condition' ? 'dialog' : 'menu'} aria-expanded={!!view}
        aria-controls={view ? popoverId : undefined}
        onClick={() => setView(view ? null : 'menu')}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !view) {
            event.preventDefault();
            setView('menu');
          }
        }}>
        <span className="insert-braces" aria-hidden="true">{'{ }'}</span> Insert
      </button>
      {view === 'menu' ? (
        <div className="insert-popover" id={popoverId} role="menu" aria-label="Insert">
          {grouped(items).map(({ group, items }) => (
            <div key={group} role="group" aria-label={group}>
              <div className="insert-group" aria-hidden="true">{group}</div>
              {items.map(option)}
            </div>
          ))}
          <div role="group" aria-label="Blocks">
            <div className="insert-group" aria-hidden="true">Blocks</div>
            <button type="button" role="menuitem" tabIndex={-1} className="insert-option" onClick={() => setView('condition')}>
              <code>{'{{if …}}…{{end}}'}</code>
              <span>Text for some Machines or agents only. Pick the Variable and value next.</span>
            </button>
            {option(LITERAL)}
          </div>
        </div>
      ) : view === 'condition' ? (
        <div className="insert-popover" id={popoverId} role="dialog" aria-label="Insert a condition">
          <div className="insert-back">
            <button type="button" className="icon-button" aria-label="Back" onClick={() => setView('menu')}>
              <Icon name="back" />
            </button>
            <span>Condition</span>
          </div>
          <ConditionBuilder values={values} onInsert={insert} />
        </div>
      ) : null}
    </div>
  );
}

/** Every Insertable laid out under the editor: the syntax reference, where each row inserts itself. */
export function InsertPalette({ items, values, onInsert, disabled }: InsertProps) {
  const row = (item: Insertable) => (
    <button key={item.expression} type="button" className="palette-item" disabled={disabled}
      // Keep the editor's focus, so its caret stays visible.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onInsert(item)}>
      <code>{item.expression}</code>
      <span>{item.description}</span>
      <span className="palette-action" aria-hidden="true"><Icon name="plus" size={12} /> Insert</span>
    </button>
  );
  return (
    <section className="palette" aria-labelledby="palette-title">
      <h2 id="palette-title">Insert at the caret</h2>
      <div className="palette-list">
        {grouped(items).map(({ group, items }, i) => (
          <div key={group} role="group" aria-label={group} className="palette-group">
            {i ? <h3 aria-hidden="true">{group}</h3> : null}
            {items.map(row)}
          </div>
        ))}
        <div role="group" aria-label="Blocks" className="palette-group">
          <h3 aria-hidden="true">Blocks</h3>
          <div className="palette-condition">
            <ConditionBuilder values={values} onInsert={onInsert} disabled={disabled} />
          </div>
          {row(LITERAL)}
        </div>
      </div>
    </section>
  );
}

const BUILTIN_NAMES = new Set(BUILTIN_VARIABLES.map((v) => v.name));

/**
 * `If [Variable] [is | is not] [value]`: clicking a value inserts the whole block around the
 * selection. The values are the ones the Variable has on your Machines; any other can be typed.
 */
function ConditionBuilder({ values, onInsert, disabled }: {
  values: ConditionValues;
  onInsert: (insert: { before: string; after: string }) => void;
  disabled?: boolean;
}) {
  const names = Object.keys(values);
  const own = names.filter((name) => !BUILTIN_NAMES.has(name));
  const [picked, setVariable] = useState('machine.os');
  const variable = names.includes(picked) ? picked : names[0]!;
  const [negate, setNegate] = useState(false);
  const [other, setOther] = useState('');
  const operator = negate ? '!=' : '==';
  const insert = (value: string) => {
    onInsert({ before: `{{if ${variable} ${operator} "${value}"}}`, after: '{{end}}' });
    setOther('');
  };
  // Keep the editor's focus on a click, so its caret stays visible.
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  return (
    <div className="condition">
      <div className="condition-row">
        <span className="condition-word">If</span>
        <select className="select small" aria-label="Variable" value={variable} disabled={disabled}
          onChange={(event) => setVariable(event.target.value)}>
          <optgroup label="Built-in">
            {names.filter((name) => BUILTIN_NAMES.has(name)).map((name) => <option key={name}>{name}</option>)}
          </optgroup>
          {own.length ? (
            <optgroup label="Your Variables">
              {own.map((name) => <option key={name}>{name}</option>)}
            </optgroup>
          ) : null}
        </select>
        <div className="segmented" role="group" aria-label="Comparison">
          <button type="button" aria-pressed={!negate} disabled={disabled} onClick={() => setNegate(false)}>is</button>
          <button type="button" aria-pressed={negate} disabled={disabled} onClick={() => setNegate(true)}>is not</button>
        </div>
      </div>
      <div className="condition-values" role="group" aria-label="Value">
        {(values[variable] ?? []).map((value) => (
          <button key={value.name} type="button" className="condition-value" title={value.description} disabled={disabled}
            onMouseDown={keepFocus} onClick={() => insert(value.name)}>
            {value.name}
          </button>
        ))}
        <form className="condition-other" onSubmit={(event) => {
          event.preventDefault();
          if (other) insert(other);
        }}>
          {/* A quoted value can't hold a quote. */}
          <input className="input" aria-label="Other value" placeholder="Other value…" value={other} disabled={disabled}
            onChange={(event) => setOther(event.target.value.replaceAll('"', ''))} />
          {other ? <button type="submit" className="button secondary small" onMouseDown={keepFocus}>Insert</button> : null}
        </form>
      </div>
      <code className="condition-preview" aria-hidden="true">
        {`{{if ${variable} ${operator} "${other || '…'}"}}…{{end}}`}
      </code>
    </div>
  );
}
