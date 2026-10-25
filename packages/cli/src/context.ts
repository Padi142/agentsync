import type { Config } from './config.js';
import { loadConfig, saveConfig } from './config.js';
import type { ExitCode } from './exit.js';
import type { Io } from './io.js';

export interface Flags {
  json: boolean;
  yes: boolean;
  server?: string;
  name?: string;
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
}

/** What a command gets: the outside world, its flags and arguments, and this Machine's config. */
export class Context {
  readonly config: Config;

  constructor(
    readonly io: Io,
    readonly flags: Flags,
    readonly args: string[],
  ) {
    this.config = loadConfig(io);
  }

  /** Whether we may prompt: a person is at the terminal and did not pass `--yes`. */
  get canAsk(): boolean {
    return this.io.interactive && !this.flags.yes && !this.flags.json && !this.flags.hook;
  }

  /**
   * Human-readable progress. With `--json` it goes to stderr, so stdout stays one JSON document.
   * Hook mode prints its own single line instead.
   */
  say(text: string): void {
    if (this.flags.hook !== undefined) return;
    if (this.flags.json) this.io.err(text);
    else this.io.out(text);
  }

  warn(text: string): void {
    if (this.flags.hook === undefined) this.io.err(text);
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
