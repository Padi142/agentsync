/** Everything the CLI needs from the outside world, so tests can supply their own. */
export interface Io {
  home: string;
  env: Record<string, string | undefined>;
  hostname: string;
  platform: NodeJS.Platform;
  fetch: typeof globalThis.fetch;
  /** Whether a person can answer prompts: stdin and stdout are terminals. */
  interactive: boolean;
  out(text: string): void;
  err(text: string): void;
  /** Ask a person a question and return the trimmed answer. Only called when `interactive`. */
  ask(question: string): Promise<string>;
  /** Open `file` in the person's editor and wait until it closes. */
  edit(file: string): Promise<void>;
  /** Start `agent` (e.g. `claude`) in the terminal with `prompt` and wait until it exits. */
  launchAgent(agent: string, prompt: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** The shell command that runs this CLI, written into agent hooks. */
  self: string;
}
