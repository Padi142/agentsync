import { drizzle } from 'drizzle-orm/d1';
import { schema } from './schema';
import type { Env } from '../env';

export function createDb(env: Pick<Env, 'DB'>) {
  return drizzle(env.DB, { schema });
}
