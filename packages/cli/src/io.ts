/** One answer to a question: a stable `value` the command branches on, and the `label` a person reads. */
export interface Choice<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

/** How a prompt is drawn. `plain` means numbered choices and ordinary text input: no cursor tricks. */
export interface PromptStyle {
  plain: boolean;
  color: boolean;
}

/** Options for a text question: a prefilled answer, and a check that returns why an answer is not accepted. */
export interface TextOptions {
  initial?: string;
  validate?: (value: string) => string | undefined;
}

/** A spinner that is running until `stop()`. */
export interface Progress {
  stop(): void;
}

/** Everything the CLI needs from the outside world, so tests can supply their own. */
export interface Io {
  home: string;
  env: Record<string, string | undefined>;
  hostname: string;
  platform: NodeJS.Platform;
  fetch: typeof globalThis.fetch;
  /** Which standard streams are terminals. Prompts need all three; color is decided per stream. */
  tty: { stdin: boolean; stdout: boolean; stderr: boolean };
  /** The terminal's width, when known. */
  columns?: number;
  out(text: string): void;
  err(text: string): void;
  /**
   * Ask a person to pick one of `choices`; Enter picks `initial`. Throws a cancellation error
   * (exit 130) on Ctrl+C. Only called when the Context says it may ask.
   */
  select<T extends string>(message: string, choices: Choice<T>[], initial: T, style: PromptStyle): Promise<T>;
  /** Ask a person to pick any of `choices`, starting with `initial` selected. */
  multiselect<T extends string>(message: string, choices: Choice<T>[], initial: T[], style: PromptStyle): Promise<T[]>;
  /** Ask a person for a line of text and return it trimmed. Enter with nothing typed accepts `initial`. */
  text(message: string, style: PromptStyle, options?: TextOptions): Promise<string>;
  /** Start a spinner on stderr. Only called when the Context allows animation. */
  progress(text: string, style: PromptStyle): Progress;
  /** Open `file` in the person's editor and wait until it closes. */
  edit(file: string): Promise<void>;
  /** Start `agent`'s command (e.g. `claude`) in the terminal with `args` and wait until it exits. */
  launchAgent(agent: string, args: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  /**
   * Run the pinned `skills` CLI with `args` (an argument array, never a shell), with no terminal and
   * telemetry off, and collect its output.
   */
  runSkills(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** The shell command that runs this CLI, written into agent hooks. */
  self: string;
}
