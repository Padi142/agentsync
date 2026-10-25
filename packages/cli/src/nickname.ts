import { usage } from './exit.js';

/**
 * The server's own rule for a Machine nickname, as a check that says why a name is not
 * accepted. Loaded lazily, because the schema brings zod and hooks never need it.
 */
export async function nicknameCheck(): Promise<(name: string) => string | undefined> {
  const { machineNicknameSchema } = await import('@agentsync/contract');
  return (name) => (machineNicknameSchema.safeParse(name).success ? undefined : 'A Machine nickname must be 1 to 100 characters.');
}

/** `name` trimmed, or a usage error (exit 2) saying what is wrong with it. */
export async function checkedNickname(name: string, what = 'The Machine nickname'): Promise<string> {
  const trimmed = name.trim();
  if ((await nicknameCheck())(trimmed)) throw usage(`${what} must be 1 to 100 characters, not "${name}".`);
  return trimmed;
}
