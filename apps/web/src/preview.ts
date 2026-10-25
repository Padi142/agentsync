import { render, type RenderContext, type RenderResult } from '@agentsync/template';

/** Where one substituted value landed in the Rendered text, and which Variable it came from. */
export interface MarkedRange {
  start: number;
  end: number;
  name: string;
}

export interface MarkedRender extends RenderResult {
  ranges: MarkedRange[];
}

const OPEN = '';
const CLOSE = '';

/**
 * `render`, plus where each substituted value landed. The text is exactly what `render` returns;
 * the ranges are found by rendering with private-use markers around each value and removing them.
 */
export function renderMarked(template: string, context: RenderContext): MarkedRender {
  const names: string[] = [];
  const marked = render(template, context, {
    mark: (value, name) => (names.push(name), OPEN + value.replaceAll(OPEN, '').replaceAll(CLOSE, '') + CLOSE),
  });
  const ranges: MarkedRange[] = [];
  let text = '';
  let start = -1;
  for (let i = 0; i < marked.text.length; i++) {
    const char = marked.text[i]!;
    if (char === OPEN) start = text.length;
    else if (char === CLOSE) ranges.push({ start, end: text.length, name: names[ranges.length] ?? '' });
    else text += char;
  }
  // A marker that came from the Template itself would shift the ranges; drop them then.
  const plain = render(template, context);
  return { ...plain, ranges: plain.text === text ? ranges : [] };
}
