import { createColors } from 'picocolors';

/**
 * The CLI's small palette: cyan for selection, green for success, yellow for attention, red
 * for failure. Every state is also said in words, so text stays complete without color or
 * Unicode; `glyphs: false` drops the status symbols too.
 */
export function palette(color: boolean, glyphs: boolean) {
  const c = createColors(color);
  const mark = (symbol: string, paint: (text: string) => string) => (text: string) =>
    glyphs ? `${paint(symbol)} ${text}` : text;
  return {
    ok: mark('✓', c.green),
    attention: mark('!', c.yellow),
    fail: mark('✗', c.red),
    green: c.green,
    yellow: c.yellow,
    red: c.red,
    accent: c.cyan,
    bold: c.bold,
  };
}

export type Palette = ReturnType<typeof palette>;
