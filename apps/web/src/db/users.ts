import type { User as WorkOSUser } from '@workos-inc/node';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from './index';
import { user } from './schema';
import type { Env } from '../env';

export type AppUser = { id: string; name: string; email: string };
const publicFields = { id: user.id, name: user.name, email: user.email };

export async function findUser(env: Pick<Env, 'DB'>, workosId: string) {
  return createDb(env).select(publicFields).from(user).where(eq(user.workosId, workosId)).get();
}

export async function provisionUser(env: Pick<Env, 'DB'>, identity: WorkOSUser): Promise<AppUser> {
  const db = createDb(env);
  const profile = {
    name: [identity.firstName, identity.lastName].filter(Boolean).join(' ') || identity.email,
    email: identity.email,
    emailVerified: identity.emailVerified,
    image: identity.profilePictureUrl,
    updatedAt: new Date(),
  };
  const [existing] = await db.update(user).set(profile)
    .where(eq(user.workosId, identity.id)).returning(publicFields);
  if (existing) return existing;

  // Preserve legacy user IDs and file ownership, but only after WorkOS proves
  // ownership of the email. Never relink an account already bound to WorkOS.
  if (identity.emailVerified) {
    const [linked] = await db.update(user).set({ ...profile, workosId: identity.id })
      .where(and(eq(user.email, identity.email), isNull(user.workosId)))
      .returning(publicFields);
    if (linked) return linked;
  }

  const [created] = await db.insert(user).values({
    ...profile, id: crypto.randomUUID(), workosId: identity.id, createdAt: new Date(),
  }).onConflictDoNothing().returning(publicFields);
  if (created) return created;
  // Another callback for the same WorkOS user may have won the insert race.
  const concurrent = await findUser(env, identity.id);
  if (concurrent) return concurrent;
  throw new Error('The email belongs to an account that cannot be linked automatically.');
}
