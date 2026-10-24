import type { Template } from '@agentsync/contract';
import { and, desc, eq } from 'drizzle-orm';
import { createDb } from './index';
import { writeRevision } from './revisions';
import { template, templateRevision } from './schema';
import type { Env } from '../env';

const empty: Template = { text: '', revision: 0, updatedAt: null };

/** The user's current Template, or the empty revision 0 if none has been saved. */
export async function getTemplate(env: Pick<Env, 'DB'>, userId: string): Promise<Template> {
  const row = await createDb(env)
    .select({ text: templateRevision.text, revision: template.revision, updatedAt: template.updatedAt })
    .from(template)
    .innerJoin(templateRevision, and(
      eq(templateRevision.userId, template.userId),
      eq(templateRevision.revision, template.revision),
    ))
    .where(eq(template.userId, userId))
    .get();
  return row ?? empty;
}

/** Save `text` as the next Template revision if the head is still `expectedRevision`. */
export async function putTemplate(
  env: Pick<Env, 'DB'>,
  userId: string,
  text: string,
  expectedRevision: number,
  options?: Parameters<typeof writeRevision>[5],
): Promise<{ ok: true; template: Template } | { ok: false; currentRevision: number }> {
  const result = await writeRevision(env.DB, 'template', userId, text, expectedRevision, options);
  if (!result.ok) return result;
  return { ok: true, template: { text, revision: result.revision, updatedAt: result.at } };
}

/** Every saved revision, newest first, without text. */
export function templateHistory(env: Pick<Env, 'DB'>, userId: string) {
  return createDb(env)
    .select({ revision: templateRevision.revision, createdAt: templateRevision.createdAt })
    .from(templateRevision)
    .where(eq(templateRevision.userId, userId))
    .orderBy(desc(templateRevision.revision))
    .all();
}

export function templateRevisionText(env: Pick<Env, 'DB'>, userId: string, revision: number) {
  return createDb(env)
    .select({ revision: templateRevision.revision, text: templateRevision.text, createdAt: templateRevision.createdAt })
    .from(templateRevision)
    .where(and(eq(templateRevision.userId, userId), eq(templateRevision.revision, revision)))
    .get();
}
