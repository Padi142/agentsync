import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../copy';
import { Icon } from './Icon';

/** A button that copies `text` and says so for a moment. */
export function CopyButton({ text, label = 'Copy', className = 'copy-button', children }: {
  text: string;
  /** The accessible name, e.g. "Copy install command". */
  label?: string;
  className?: string;
  /** Visible text beside the icon. Without it the button is icon-only. */
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(text);
    setCopied(ok);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button type="button" className={className} onClick={copy} aria-label={children ? undefined : label}
      title={children ? undefined : label} data-copied={copied || undefined}>
      <Icon name={copied ? 'check' : 'copy'} />
      {children ? <span>{copied ? 'Copied' : children}</span> : null}
      <span className="visually-hidden" role="status">{copied ? 'Copied' : ''}</span>
    </button>
  );
}

/** One shell command. Its `$` prompt is drawn by CSS, so it's never copied or selected. */
export function Command({ command, label, note }: { command: string; label?: string; note?: ReactNode }) {
  return (
    <div className="command">
      <div className="command-line">
        <code aria-label={label}>{command}</code>
        <CopyButton text={command} label={`Copy ${label ? label.toLowerCase() : 'command'}`} />
      </div>
      {note ? <p className="command-note">{note}</p> : null}
    </div>
  );
}

/** A longer block of text, such as a prompt, with a copy button in its header. */
export function CopyBlock({ text, label, title }: { text: string; label: string; title: ReactNode }) {
  return (
    <figure className="copy-block">
      <figcaption>
        <span>{title}</span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} className="button small">Copy</CopyButton>
      </figcaption>
      <pre aria-label={label} tabIndex={0}>{text}</pre>
    </figure>
  );
}
