import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Context } from './context.js';
import { CliError, describeError, exitCodeFor } from './exit.js';
import { readText, removeFile, writeText } from './files.js';
import { configDir } from './paths.js';

/** How to pick an edit up again if saving it fails: one sentence with the command that saves the kept file. */
export type Recovery = (file: string) => string;

/**
 * Run `use` with a draft file holding `text`, in a private folder of the config directory.
 * The draft is deleted when `use` returns, which is success or an explicit cancel. If `use`
 * throws, the draft may hold the person's only copy of an edit, so it is kept and the error
 * says where it is and how to save it.
 */
export async function withDraft<T>(
  ctx: Context,
  name: string,
  text: string,
  recovery: Recovery,
  use: (file: string) => Promise<T>,
): Promise<T> {
  const file = join(configDir(ctx.io), 'drafts', `${randomBytes(4).toString('hex')}-${name}`);
  writeText(file, text, { createMode: 0o600, dirMode: 0o700 });
  let result: T;
  try {
    result = await use(file);
  } catch (error) {
    throw new CliError(
      `${describeError(error)} Your edit is kept in ${file}. ${recovery(file)}`,
      exitCodeFor(error),
      error instanceof CliError ? error.details : {},
    );
  }
  removeFile(file);
  return result;
}

export const readDraft = (file: string) => readText(file) ?? '';
