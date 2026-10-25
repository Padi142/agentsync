import { markConflicts } from './merge';

/** One side of a Conflict hunk: its marker label and its lines. */
export interface HunkSide {
  label: string;
  lines: string[];
}

/** A `<<<<<<<` … `>>>>>>>` region of a Conflict's text. Lines are 1-based and include the markers. */
export interface ConflictHunk {
  firstLine: number;
  lastLine: number;
  current: HunkSide;
  edit: HunkSide;
}

/** The marked hunks in `text`, in order. A hunk without its closing marker is left out. */
export function conflictHunks(text: string): ConflictHunk[] {
  const lines = text.split('\n');
  const hunks: ConflictHunk[] = [];
  let open: { firstLine: number; current: HunkSide; edit: HunkSide | null } | null = null;
  lines.forEach((line, i) => {
    if (line.startsWith('<<<<<<<')) {
      open = { firstLine: i + 1, current: { label: label(line), lines: [] }, edit: null };
    } else if (!open) {
      return;
    } else if (line === '=======' && !open.edit) {
      open.edit = { label: '', lines: [] };
    } else if (line.startsWith('>>>>>>>') && open.edit) {
      hunks.push({ firstLine: open.firstLine, lastLine: i + 1, current: open.current, edit: { ...open.edit, label: label(line) } });
      open = null;
    } else {
      (open.edit ?? open.current).lines.push(line);
    }
  });
  return hunks;
}

const label = (marker: string) => marker.slice(7).trim();

export type Side = 'current' | 'edit' | 'both';

/** `text` with `hunk` replaced by the chosen side's lines. */
export function pickSide(text: string, hunk: ConflictHunk, side: Side): string {
  const kept = side === 'both' ? [...hunk.current.lines, ...hunk.edit.lines] : hunk[side].lines;
  const lines = text.split('\n');
  lines.splice(hunk.firstLine - 1, hunk.lastLine - hunk.firstLine + 1, ...kept);
  return lines.join('\n');
}

/**
 * Merge a resolution made against the Template `mergedAgainst` with the `newer` Template
 * that has been saved since, marking the lines both changed. Used after `CONFLICT` on resolve.
 */
export function remerge(
  mergedAgainst: { text: string },
  newer: { revision: number; text: string },
  resolution: string,
): string {
  return markConflicts(
    mergedAgainst.text,
    { text: newer.text, label: `Template revision ${newer.revision}` },
    { text: resolution, label: 'your resolution' },
  );
}
