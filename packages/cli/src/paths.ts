import { isAbsolute, join, relative } from 'node:path';
import type { Io } from './io.js';

/** Turn `~/x` into an absolute path in the Machine's home directory. */
export function expandHome(path: string, io: Io): string {
  if (path === '~') return io.home;
  if (path.startsWith('~/')) return join(io.home, path.slice(2));
  return path;
}

/** The inverse of `expandHome`: paths under home are stored as `~/…` so they read the same on every Machine. */
export function tildify(path: string, io: Io): string {
  const inside = relative(io.home, path);
  if (inside === '') return '~';
  if (!inside.startsWith('..') && !isAbsolute(inside)) return `~/${inside.split('\\').join('/')}`;
  return path;
}

export function configDir(io: Io): string {
  if (io.env.AGENTSYNC_CONFIG_DIR) return io.env.AGENTSYNC_CONFIG_DIR;
  return join(io.env.XDG_CONFIG_HOME || join(io.home, '.config'), 'agentsync');
}
