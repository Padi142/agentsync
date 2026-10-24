import { useRef } from 'react';

export interface LineMark {
  line: number;
  kind: 'error' | 'warning';
  message: string;
}

/**
 * A plain textarea with a line-number gutter. Marked lines are highlighted in the gutter.
 * Lines don't wrap, so gutter numbers stay aligned with the text.
 */
export function CodeEditor({ value, onChange, marks = [], label, rows = 20 }: {
  value: string;
  onChange: (value: string) => void;
  marks?: LineMark[];
  label: string;
  rows?: number;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const lineCount = value.split('\n').length;
  const markAt = new Map(marks.map((mark) => [mark.line, mark]));
  return (
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
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
        }}
        wrap="off"
        spellCheck={false}
      />
    </div>
  );
}
