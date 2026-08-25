import { ORPCError, os } from '@orpc/server';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getSession, type AuthSession } from '../auth';
import { createDb } from '../db';
import { file } from '../db/schema';
import type { Env } from '../env';

export interface RPCContext {
  env: Env;
  request: Request;
  session: AuthSession;
}

const base = os.$context<RPCContext>();

const protectedProcedure = base.use(async ({ context, next }) => {
  if (!context.session?.user) {
    throw new ORPCError('UNAUTHORIZED');
  }

  return next({ context: { user: context.session.user } });
});

const fileRecord = z.object({
  id: z.string(),
  path: z.string(),
  content: z.string(),
  revision: z.number().int(),
  updatedAt: z.date(),
});

const list = protectedProcedure
  .handler(async ({ context }) => {
    const rows = await createDb(context.env)
      .select({
        id: file.id,
        path: file.path,
        content: file.content,
        revision: file.revision,
        updatedAt: file.updatedAt,
      })
      .from(file)
      .where(eq(file.userId, context.user.id))
      .orderBy(asc(file.path))
      .all();

    return rows;
  });

const create = protectedProcedure
  .input(
    z.object({
      path: z.string().trim().min(1).max(200),
      content: z.string().max(500_000),
    }),
  )
  .handler(async ({ context, input }) => {
    const now = new Date();
    const id = crypto.randomUUID();

    await createDb(context.env)
      .insert(file)
      .values({
        id,
        userId: context.user.id,
        path: input.path,
        content: input.content,
        revision: 1,
        updatedAt: now,
      })
      .run();

    return {
      id,
      path: input.path,
      content: input.content,
      revision: 1,
      updatedAt: now,
    } satisfies z.infer<typeof fileRecord>;
  });

const update = protectedProcedure
  .input(
    z.object({
      id: z.string().min(1),
      path: z.string().trim().min(1).max(200),
      content: z.string().max(500_000),
      expectedRevision: z.number().int().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    const now = new Date();
    const nextRevision = input.expectedRevision + 1;
    const result = await createDb(context.env)
      .update(file)
      .set({
        path: input.path,
        content: input.content,
        revision: nextRevision,
        updatedAt: now,
      })
      .where(
        and(
          eq(file.id, input.id),
          eq(file.userId, context.user.id),
          eq(file.revision, input.expectedRevision),
        ),
      )
      .run();

    if (result.meta.changes !== 1) {
      throw new ORPCError('CONFLICT');
    }

    return {
      id: input.id,
      path: input.path,
      content: input.content,
      revision: nextRevision,
      updatedAt: now,
    } satisfies z.infer<typeof fileRecord>;
  });

const session = base.handler(async ({ context }) => {
  if (!context.session?.user) {
    return null;
  }

  return {
    id: context.session.user.id,
    name: context.session.user.name,
    email: context.session.user.email,
  };
});

export const router = {
  health: base.handler(() => ({ ok: true as const })),
  session,
  files: {
    list,
    create,
    update,
  },
};

export type AppRouter = typeof router;

export async function createRPCContext(request: Request, env: Env) {
  return {
    env,
    request,
    session: await getSession(request, env),
  } satisfies RPCContext;
}
