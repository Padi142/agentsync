import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, removeFile, writeJson } from './files.js';
import type { Handler } from './hooks.js';
import type { Io } from './io.js';
import type { Owned } from './owned.js';
import { configDir } from './paths.js';

/** A device flow started by `init --no-wait`, resumed by the next `init`. */
export interface PendingLogin {
  server: string;
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  interval: number;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** The Machine nickname chosen when the registration started. Older configs lack it. */
  nickname?: string;
}

/**
 * This Machine's AgentSync state, in one per-user file with mode 0600 because it holds the
 * Machine token. `written` keeps the text last written to each Target (keyed by its stored
 * path, e.g. `~/.claude/CLAUDE.md`): Drift is a Target that no longer matches it, and keeping
 * the text rather than a hash lets us show the hand edit as a diff.
 */
export interface Config {
  server?: string;
  token?: string;
  machineId?: string;
  pending?: PendingLogin;
  /** The agent that `edit` and `sync` hand Conflicts and Drift to. */
  handoffAgent?: string;
  /** The exact hook handler installed in each agent's hook file, so only that is ever removed. */
  hooks?: Record<string, Handler>;
  /** A SHA-256 of each skill file AgentSync wrote, so a file someone changed is left alone. */
  skills?: Owned;
  /** The same for each pi extension AgentSync wrote as a hook. */
  extensions?: Owned;
  written: Record<string, string>;
}

export const configFile = (io: Io) => join(configDir(io), 'config.json');

export function loadConfig(io: Io): Config {
  const config = readJson<Partial<Config>>(configFile(io), {});
  return { ...config, written: config.written ?? {} };
}

/** The config holds the Machine token: the file is 0600 and its directory 0700, even if they were looser. */
export function saveConfig(io: Io, config: Config): void {
  const file = configFile(io);
  writeJson(file, config, { mode: 0o600, dirMode: 0o700 });
  chmodSync(dirname(file), 0o700);
}

export function deleteConfig(io: Io): void {
  removeFile(configFile(io));
}
