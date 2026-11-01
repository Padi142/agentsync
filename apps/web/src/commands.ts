import { useSyncExternalStore } from 'react';

/** This server, as the CLI should reach it. */
export const serverUrl = () => window.location.origin;

/** Until the CLI is published to npm, it runs from a clone of this repository. */
export const repoUrl = 'https://github.com/Padi142/agentsync.git';

/**
 * Stands for the folder the CLI is cloned into, in commands, docs code blocks and the setup
 * prompt. The reader can edit it wherever it's shown (see `InstallDirInput`); `fillInstallDir`
 * swaps in their choice for copying.
 */
export const INSTALL_DIR = '<INSTALL_DIR>';
export const defaultInstallDir = '~/agentsync';

/** Builds the CLI from a clone, puts `agentsync` on PATH, and registers this computer with this server. */
export const installCommand = (server = serverUrl()) =>
  `git clone ${repoUrl} ${INSTALL_DIR} && cd ${INSTALL_DIR} && pnpm install && pnpm build && (cd packages/cli && npm link) && agentsync init --server ${server}`;

/**
 * `dir` as a shell word. A leading `~/` stays unquoted so the shell still expands it; anything
 * after it with spaces or other special characters is single-quoted. Blank means the default.
 */
export function shellPath(dir: string) {
  const path = dir.trim() || defaultInstallDir;
  if (/^[\w@%+=:,./~-]+$/.test(path)) return path;
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  return path.startsWith('~/') ? `~/${quote(path.slice(2))}` : quote(path);
}

export const fillInstallDir = (text: string, dir: string) => text.replaceAll(INSTALL_DIR, shellPath(dir));

// The chosen folder is remembered in localStorage, and every input on the page follows it.
const storageKey = 'agentsync:install-dir';
const listeners = new Set<() => void>();
let installDir: string | undefined;

const readInstallDir = () => {
  if (installDir === undefined) {
    try {
      installDir = localStorage.getItem(storageKey) ?? defaultInstallDir;
    } catch {
      installDir = defaultInstallDir;
    }
  }
  return installDir;
};

export function setInstallDir(dir: string) {
  installDir = dir;
  try {
    localStorage.setItem(storageKey, dir);
  } catch {
    // Private mode or storage full: the folder just isn't remembered.
  }
  listeners.forEach((notify) => notify());
}

const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => listeners.delete(notify);
};

/** The folder this reader clones the CLI into. Set it with `setInstallDir`. */
export const useInstallDir = () => useSyncExternalStore(subscribe, readInstallDir, () => defaultInstallDir);
