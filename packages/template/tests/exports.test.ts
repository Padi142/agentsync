import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const consumerDir = fileURLToPath(new URL('./node-consumer', import.meta.url));
const tsc = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);
const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, encoding: 'utf8' });

it('builds to JS and .d.ts that a NodeNext consumer imports by package name', () => {
  run(process.execPath, [tsc, '-p', 'tsconfig.build.json'], packageDir);
  run(process.execPath, [tsc, '-p', 'tsconfig.json'], consumerDir);
  expect(run(process.execPath, ['dist/consumer.js'], consumerDir)).toBe(
    'claude on laptop\n',
  );
}, 60_000);
