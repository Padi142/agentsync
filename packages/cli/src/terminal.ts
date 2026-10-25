import { createInterface } from 'node:readline/promises';
import { cancelled } from './exit.js';
import type { Choice, Io, Progress, PromptStyle } from './io.js';

/**
 * The real terminal behind `Io`'s prompts and spinner. Clack draws the arrow-key prompts and
 * ora the spinner, both on stderr, so stdout keeps only results. They are loaded on first use,
 * so a hook never pays for them. `--plain` uses numbered choices on ordinary readline instead.
 */

/** Clack and ora pick their own colors; without color, tell them through the convention they follow. */
function monochrome(style: PromptStyle): void {
  if (style.color) return;
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
}

async function line(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const abort = new AbortController();
  readline.on('SIGINT', () => abort.abort());
  try {
    return (await readline.question(question, { signal: abort.signal })).trim();
  } catch (error) {
    if (abort.signal.aborted) throw cancelled();
    throw error;
  } finally {
    readline.close();
  }
}

/** Numbered choices for `--plain`: type the numbers, or press Enter for the default. */
async function numbered<T extends string>(message: string, choices: Choice<T>[], initial: T[], many: boolean): Promise<T[]> {
  process.stderr.write(`${message}\n`);
  choices.forEach((choice, index) => {
    const mark = initial.includes(choice.value) ? ' (default)' : '';
    process.stderr.write(`  ${index + 1}. ${choice.label}${choice.hint ? ` - ${choice.hint}` : ''}${mark}\n`);
  });
  const hint = many ? 'numbers separated by commas' : `1-${choices.length}`;
  for (;;) {
    const answer = await line(`Choose ${hint}, or press Enter for the default: `);
    if (!answer) return initial;
    const picked = answer.split(/[\s,]+/).map((part) => choices[Number(part) - 1]);
    if (picked.every((choice) => choice) && (many || picked.length === 1)) return picked.map((choice) => choice!.value);
    process.stderr.write(`Please answer ${hint}.\n`);
  }
}

export const terminal: Pick<Io, 'select' | 'multiselect' | 'text' | 'progress'> = {
  async select(message, choices, initial, style) {
    if (style.plain) return (await numbered(message, choices, [initial], false))[0]!;
    monochrome(style);
    const clack = await import('@clack/prompts');
    const options = choices.map(({ value, label, hint }) => ({ value, label, ...(hint ? { hint } : {}) }));
    const answer = await clack.select({ message, options: options as never, initialValue: initial, output: process.stderr });
    if (clack.isCancel(answer)) throw cancelled();
    return answer as typeof initial;
  },
  async multiselect(message, choices, initial, style) {
    if (style.plain) return numbered(message, choices, initial, true);
    monochrome(style);
    const clack = await import('@clack/prompts');
    const options = choices.map(({ value, label, hint }) => ({ value, label, ...(hint ? { hint } : {}) }));
    const answer = await clack.multiselect({
      message,
      options: options as never,
      initialValues: initial,
      required: false,
      output: process.stderr,
    });
    if (clack.isCancel(answer)) throw cancelled();
    return answer as typeof initial;
  },
  async text(message, style) {
    if (style.plain) return line(`${message} `);
    monochrome(style);
    const clack = await import('@clack/prompts');
    const answer = await clack.text({ message, output: process.stderr });
    if (clack.isCancel(answer)) throw cancelled();
    return (answer ?? '').trim();
  },
  progress(text, style): Progress {
    monochrome(style);
    // Loaded lazily, but the spinner must start now: show it once ora is ready, unless stopped first.
    let stopped = false;
    let spinner: { stop(): unknown } | undefined;
    void import('ora').then(({ default: ora }) => {
      if (stopped) return;
      spinner = ora({ text, stream: process.stderr, discardStdin: false, color: 'cyan' }).start();
    });
    return {
      stop() {
        stopped = true;
        spinner?.stop();
      },
    };
  },
};
