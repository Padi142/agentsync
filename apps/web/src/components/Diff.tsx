import { diffComm } from 'node-diff3';

type Region = { common: string[] } | { buffer1: string[]; buffer2: string[] };
type Row = { sign: ' ' | '-' | '+'; line: string } | { folded: number };

/** Unchanged lines shown around each change; longer unchanged runs are folded. */
const CONTEXT = 3;

/** A line diff from `before` to `after`: removed lines, then added lines, between unchanged ones. */
export function Diff({ before, after }: { before: string; after: string }) {
  if (before === after) return <p className="muted">No changes.</p>;
  const regions = diffComm(before.split('\n'), after.split('\n')) as Region[];
  const rows = regions.flatMap((region, i): Row[] => {
    if (!('common' in region)) {
      return [
        ...region.buffer1.map((line) => ({ sign: '-' as const, line })),
        ...region.buffer2.map((line) => ({ sign: '+' as const, line })),
      ];
    }
    const lines = region.common;
    const head = i === 0 ? 0 : CONTEXT;
    const tail = i === regions.length - 1 ? 0 : CONTEXT;
    const unchanged = (line: string) => ({ sign: ' ' as const, line });
    if (lines.length <= head + tail + 1) return lines.map(unchanged);
    return [
      ...lines.slice(0, head).map(unchanged),
      { folded: lines.length - head - tail },
      ...lines.slice(lines.length - tail).map(unchanged),
    ];
  });
  return (
    <pre className="diff">
      {rows.map((row, i) => 'folded' in row
        ? <div key={i} className="folded">⋯ {row.folded} unchanged {row.folded === 1 ? 'line' : 'lines'}</div>
        : (
          <div key={i} className={row.sign === '-' ? 'removed' : row.sign === '+' ? 'added' : undefined}>
            <span className="diff-sign" aria-hidden="true">{row.sign}</span>
            {row.line || ' '}
          </div>
        ))}
    </pre>
  );
}
