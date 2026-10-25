import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readText, writeText } from './files.js';

/** Run `use` with a temporary file holding `text`, then delete it. */
export async function withScratchFile<T>(name: string, text: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agentsync-'));
  const file = join(dir, name);
  writeText(file, text);
  try {
    return await use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const readScratch = (file: string) => readText(file) ?? '';
