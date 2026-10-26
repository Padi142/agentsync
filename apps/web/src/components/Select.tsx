import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  /** Options with the same group are listed together under its name. */
  group?: string;
}

/**
 * A select whose list looks like the editor's `{{` suggestions. Focus stays on the button, as
 * with a native select: arrows move, Enter or Space picks, Escape closes, a letter jumps.
 */
export function Select({ label, value, options, onChange, disabled, mono }: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Show the labels as code, for Variable names. */
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const chosen = Math.max(0, options.findIndex((o) => o.value === value));

  const show = () => {
    setActive(chosen);
    setOpen(true);
  };
  const pick = (i: number) => {
    setOpen(false);
    const option = options[i];
    if (option && option.value !== value) onChange(option.value);
  };

  // The list sits in the top layer, so no scrolling parent clips it. Below the button, or above it
  // when there's no room.
  useLayoutEffect(() => {
    const popup = list.current;
    if (!open || !popup || !button.current) return setPlace(null);
    popup.showPopover?.();
    const rect = button.current.getBoundingClientRect();
    const height = popup.offsetHeight;
    const below = rect.bottom + 4 + height <= window.innerHeight || rect.top < height + 4;
    setPlace({
      top: below ? rect.bottom + 4 : rect.top - 4 - height,
      left: Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8),
      minWidth: rect.width,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!button.current?.contains(event.target as Node) && !list.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (event: KeyboardEvent) => {
    const move = (i: number) => {
      event.preventDefault();
      if (!open) show();
      else setActive(Math.max(0, Math.min(options.length - 1, i)));
    };
    if (event.key === 'ArrowDown') move(active + 1);
    else if (event.key === 'ArrowUp') move(active - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(options.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) pick(active);
      else show();
    } else if (event.key === 'Escape' && open) {
      // Close only the list, not a menu it sits in.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'Tab') setOpen(false);
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Jump to the next option starting with the typed letter.
      const from = open ? active : chosen;
      const at = [...options.keys()].map((k) => (from + 1 + k) % options.length)
        .find((i) => options[i]!.label.toLowerCase().startsWith(event.key.toLowerCase()));
      if (at === undefined) return;
      if (open) setActive(at);
      else pick(at);
    }
  };

  let group: string | undefined;
  return (
    <>
      <button ref={button} type="button" className="select small" disabled={disabled} data-mono={mono || undefined}
        role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKeyDown}>
        {options[chosen]?.label ?? ''}
      </button>
      {open ? (
        <ul ref={list} id={id} popover="manual" role="listbox" aria-label={label} className="suggestions select-list"
          style={place ? { top: place.top, left: place.left, minWidth: place.minWidth } : { visibility: 'hidden' }}>
          {options.map((option, i) => {
            const heading = option.group !== group ? (group = option.group) : undefined;
            return [
              heading ? <li key={`group-${heading}`} role="presentation" className="insert-group">{heading}</li> : null,
              <li key={option.value} id={`${id}-${i}`} data-index={i} role="option" aria-selected={i === chosen}
                className="suggestion" data-active={i === active || undefined}
                // Keep focus on the button.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(i)} onClick={() => pick(i)}>
                {mono ? <code>{option.label}</code> : <strong>{option.label}</strong>}
                {option.description ? <span>{option.description}</span> : null}
                {i === chosen ? <span className="select-check"><Icon name="check" size={14} /></span> : null}
              </li>,
            ];
          })}
        </ul>
      ) : null}
    </>
  );
}
