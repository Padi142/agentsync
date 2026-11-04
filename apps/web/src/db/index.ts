import { drizzle } from 'drizzle-orm/d1';
import { schema } from './schema';
import type { Env } from '../env';

/** `env` with a count of the D1 statements made through it: a Worker invocation may only make so many. */
export function countQueries<E extends Pick<Env, 'DB'>>(env: E) {
  const usage = { queries: 0 };
  const DB = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') usage.queries++;
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB }, usage };
}

export function createDb(env: Pick<Env, 'DB'>) {
  return drizzle(env.DB, { schema });
}
