import { BUILTIN_VARIABLES } from '@agentsync/template';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
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

/** Every Insertable, in the order the menu and the palette show them. */
export function insertables(own: readonly Suggestion[] = []): Insertable[] {
  const variable = (group: string) => ({ name, description }: Suggestion): Insertable =>
    ({ group, expression: `{{${name}}}`, description, before: `{{${name}}}` });
  return [
    ...BUILTIN_VARIABLES.map(variable('Built-in')),
    ...own.map(variable('Your Variables')),
    {
      group: 'Blocks',
      expression: '{{if agent == "codex"}}…{{end}}',
      description: 'Text for some Machines or agents only. Wraps the selection; {{else}} and != work too.',
      before: '{{if agent == "codex"}}',
      after: '{{end}}',
    },
    { group: 'Blocks', expression: '\\{{', description: 'A literal {{.', before: '\\{{' },
  ];
}

function grouped(items: readonly Insertable[]) {
  return [...new Set(items.map((item) => item.group))].map((group) => ({
    group,
    items: items.filter((item) => item.group === group),
  }));
}

/** A header button that opens every Insertable, grouped, like the `{{` suggestions. */
export function InsertMenu({ items, onInsert, disabled }: {
  items: readonly Insertable[];
  onInsert: (item: Insertable) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const menuItems = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    menuItems()[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
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
    else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    } else if (event.key === 'Tab') setOpen(false);
  };

  return (
    <div className="insert-menu" ref={root} onKeyDown={open ? onKeyDown : undefined}>
      <button ref={button} type="button" className="button secondary small" disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}>
        <span className="insert-braces" aria-hidden="true">{'{ }'}</span> Insert
      </button>
      {open ? (
        <div className="insert-popover" id={menuId} role="menu" aria-label="Insert">
          {grouped(items).map(({ group, items }) => (
            <div key={group} role="group" aria-label={group}>
              <div className="insert-group" aria-hidden="true">{group}</div>
              {items.map((item) => (
                <button key={item.expression} type="button" role="menuitem" tabIndex={-1} className="insert-option"
                  onClick={() => {
                    setOpen(false);
                    onInsert(item);
                  }}>
                  <code>{item.expression}</code>
                  <span>{item.description}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Every Insertable laid out under the editor: the syntax reference, where each row inserts itself. */
export function InsertPalette({ items, onInsert, disabled }: {
  items: readonly Insertable[];
  onInsert: (item: Insertable) => void;
  disabled?: boolean;
}) {
  return (
    <section className="palette" aria-labelledby="palette-title">
      <h2 id="palette-title">Insert at the caret</h2>
      <div className="palette-list">
        {grouped(items).map(({ group, items }, i) => (
          <div key={group} role="group" aria-label={group} className="palette-group">
            {i ? <h3 aria-hidden="true">{group}</h3> : null}
            {items.map((item) => (
              <button key={item.expression} type="button" className="palette-item" disabled={disabled}
                // Keep the editor's focus, so its caret stays visible.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onInsert(item)}>
                <code>{item.expression}</code>
                <span>{item.description}</span>
                <span className="palette-action" aria-hidden="true"><Icon name="plus" size={12} /> Insert</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
