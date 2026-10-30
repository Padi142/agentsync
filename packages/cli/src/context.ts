import type { Config } from './config.js';
import { loadConfig, saveConfig } from './config.js';
import type { ExitCode } from './exit.js';
import type { Choice, Io, PromptStyle, TextOptions } from './io.js';
import { palette, type Palette } from './style.js';

export interface Flags {
  json: boolean;
  yes: boolean;
  verbose: boolean;
  /** `--no-color` turns it off. */
  color: boolean;
  /** `--no-progress` turns it off. */
  progress: boolean;
  plain: boolean;
  server?: string;
  nickname?: string;
  agent: string[];
  target: string[];
  var: string[];
  unset: string[];
  import?: string;
  overwrite: boolean;
  keep: boolean;
  hook?: string;
  hooks: boolean;
  skill: boolean;
  wait: boolean;
  file?: string;
  base?: string;
  out?: string;
  limit?: string;
}

/** How long a wait must last before a spinner appears, so quick requests do not flash one. */
const PROGRESS_DELAY_MS = 150;

/** What a command gets: the outside world, its flags and arguments, and this Machine's config. */
export class Context {
  readonly config: Config;
  /** Colors and status symbols for stdout and for stderr, each decided by its own stream. */
  readonly paint: { out: Palette; err: Palette };

  constructor(
    readonly io: Io,
    readonly flags: Flags,
    readonly args: string[],
  ) {
    this.config = loadConfig(io);
    const color = (tty: boolean) => this.decorated(tty) && flags.color && !io.env.NO_COLOR;
    this.paint = {
      out: palette(color(io.tty.stdout), this.decorated(io.tty.stdout)),
      err: palette(color(io.tty.stderr), this.decorated(io.tty.stderr)),
    };
  }

  /** Whether output to a stream may carry decoration at all: a terminal, and no machine or plain mode. */
  private decorated(tty: boolean): boolean {
    return tty && !this.flags.plain && !this.flags.json && this.flags.hook === undefined && this.io.env.TERM !== 'dumb';
  }

  /** Whether we may prompt: a person is at a capable terminal and did not pass `--yes`. */
  get canAsk(): boolean {
    const { tty, env } = this.io;
    return (
      tty.stdin && tty.stdout && tty.stderr && !this.flags.yes && !this.flags.json && this.flags.hook === undefined &&
      !env.CI && env.TERM !== 'dumb'
    );
  }

  private get style(): PromptStyle {
    return { plain: this.flags.plain, color: this.flags.color && !this.io.env.NO_COLOR };
  }

  /** Whether a spinner may run on stderr. */
  private get animate(): boolean {
    return this.decorated(this.io.tty.stderr) && this.flags.progress && !this.flags.yes && !this.io.env.CI;
  }

  select<T extends string>(message: string, choices: Choice<T>[], initial: T): Promise<T> {
    return this.io.select(message, choices, initial, this.style);
  }

  multiselect<T extends string>(message: string, choices: Choice<T>[], initial: T[]): Promise<T[]> {
    return this.io.multiselect(message, choices, initial, this.style);
  }

  text(message: string, options?: TextOptions): Promise<string> {
    return this.io.text(message, this.style, options);
  }

  /**
   * Run `work` with a spinner saying `text` once it has taken a moment. Never prompt inside
   * `work`: the spinner owns the terminal until it returns.
   */
  async during<T>(text: string, work: () => Promise<T>): Promise<T> {
    if (!this.animate) return work();
    let progress: { stop(): void } | undefined;
    const timer = setTimeout(() => (progress = this.io.progress(text, this.style)), PROGRESS_DELAY_MS);
    try {
      return await work();
    } finally {
      clearTimeout(timer);
      progress?.stop();
    }
  }

  /**
   * Human-readable narration. With `--json` it goes to stderr, so stdout stays one JSON document.
   * Hook mode prints its own single line instead.
   */
  say(text: string): void {
    if (this.flags.hook !== undefined) return;
    if (this.flags.json) this.io.err(text);
    else this.io.out(text);
  }

  /** The outcome of a command, marked as a success. `--json` carries it in its data instead. */
  success(text: string): void {
    if (this.flags.hook === undefined && !this.flags.json) this.io.out(this.paint.out.ok(text));
  }

  /** Detail for `--verbose`: per-file steps, paths, full diffs. */
  detail(text: string): void {
    if (this.flags.verbose && this.flags.hook === undefined && !this.flags.json) this.io.out(text);
  }

  /** Something a person should act on or know: always shown, on stderr. */
  warn(text: string): void {
    if (this.flags.hook === undefined) this.io.err(this.paint.err.attention(text));
  }

  save(): void {
    saveConfig(this.io, this.config);
  }
}

/** What a command returns: its exit code and the data `--json` prints. */
export interface Outcome {
  code?: ExitCode;
  data?: Record<string, unknown>;
}
