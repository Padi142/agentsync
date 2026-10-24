import { contract, type Machine, type ProcedureMeta, type TemplateIssue } from '@agentsync/contract';
import { hasConflictMarkers, isSettableVariableName, validate } from '@agentsync/template';
import { implement, ORPCError } from '@orpc/server';
import type { AuthSession } from '../auth';
import {
  conflictsUrl, countOpenConflicts, createConflict, discardConflict, getConflict,
  listOpenConflicts, resolveConflict,
} from '../db/conflicts';
import {
  authenticateMachine, getMachine, listMachines, revokeMachine, updateMachine,
} from '../db/machines';
import { getTemplate, putTemplate, templateHistory, templateRevisionText } from '../db/templates';
import { getVariables, putVariables, variablesHistory } from '../db/variables';
import { pollDeviceFlow, startDeviceFlow } from '../device';
import type { Env } from '../env';

export interface RPCContext {
  env: Env;
  request: Request;
  session: AuthSession;
}

const os = implement(contract).$context<RPCContext>();

/** A signed-in user, or one of their Machines acting with its token. */
interface Caller {
  userId: string;
  machine: Machine | null;
}

/**
 * Who is calling: a signed-in browser, or a Machine with its token.
 * Accepts only the auth kinds the contract lists in the procedure's meta.
 */
const auth = os.middleware(async ({ context, procedure, next }) => {
  const accepts = (procedure['~orpc'].meta as ProcedureMeta).auth;
  const bearer = context.request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  const user = context.session.user;
  // A request with a token acts as that Machine only, even if a session cookie came too.
  const caller: Caller | null = bearer
    ? accepts.includes('machine') ? await authenticateMachine(context.env, bearer) : null
    : accepts.includes('session') && user ? { userId: user.id, machine: null } : null;
  if (!caller) throw new ORPCError('UNAUTHORIZED');
  return next({ context: caller });
});

/**
 * The Machine `machineId` names, if the caller may reach it: any of a session user's
 * Machines, or only itself for a Machine token. Anything else looks like it does not exist.
 */
async function reachableMachine(context: Caller & { env: Env }, machineId: string) {
  if (context.machine) return context.machine.id === machineId ? context.machine : undefined;
  return getMachine(context.env, context.userId, machineId);
}

/**
 * Why `text` cannot be saved as a Template, or `[]`. A Conflict resolution must also have
 * no markers left. A lone `=======` is allowed: it may be a Markdown heading underline,
 * so clients warn about it with `suspectedConflictMarkers` instead.
 */
function templateIssues(text: string, { resolving = false } = {}): TemplateIssue[] {
  const issue = validate(text);
  const issues: TemplateIssue[] = issue ? [{ message: issue.message, line: issue.line, column: issue.column }] : [];
  if (resolving) {
    const line = text.split('\n').findIndex((l) => hasConflictMarkers(l));
    if (line >= 0) issues.push({ message: 'A Conflict marker is left in the text.', line: line + 1, column: 1 });
  }
  return issues;
}

export const router = os.router({
  health: os.health.handler(() => ({ ok: true as const })),
  session: os.session.handler(({ context }) => context.session.user),
  template: {
    get: os.template.get.use(auth).handler(({ context }) => getTemplate(context.env, context.userId)),
    put: os.template.put.use(auth).handler(async ({ context, input, errors }) => {
      const issues = templateIssues(input.text);
      if (issues.length) throw errors.INVALID_TEMPLATE({ data: { issues } });
      const result = await putTemplate(context.env, context.userId, input.text, input.expectedRevision);
      if (!result.ok) throw errors.CONFLICT({ data: { currentRevision: result.currentRevision } });
      return result.template;
    }),
    history: os.template.history.use(auth).handler(({ context }) => templateHistory(context.env, context.userId)),
    revision: os.template.revision.use(auth).handler(async ({ context, input, errors }) => {
      const revision = await templateRevisionText(context.env, context.userId, input.revision);
      if (!revision) throw errors.NOT_FOUND();
      return revision;
    }),
    // Old revisions were validated when saved, so a rollback is not validated again.
    rollback: os.template.rollback.use(auth).handler(async ({ context, input, errors }) => {
      const revision = await templateRevisionText(context.env, context.userId, input.revision);
      if (!revision) throw errors.NOT_FOUND();
      const result = await putTemplate(context.env, context.userId, revision.text, input.expectedRevision);
      if (!result.ok) throw errors.CONFLICT({ data: { currentRevision: result.currentRevision } });
      return result.template;
    }),
  },
  machines: {
    list: os.machines.list.use(auth).handler(({ context }) => listMachines(context.env, context.userId)),
    get: os.machines.get.use(auth).handler(async ({ context, input, errors }) => {
      const found = await reachableMachine(context, input.machineId);
      if (!found) throw errors.NOT_FOUND();
      return found;
    }),
    update: os.machines.update.use(auth).handler(async ({ context, input, errors }) => {
      if (!await reachableMachine(context, input.machineId)) throw errors.NOT_FOUND();
      const updated = await updateMachine(context.env, context.userId, input.machineId, input);
      if (!updated) throw errors.NOT_FOUND();
      return updated;
    }),
    revoke: os.machines.revoke.use(auth).handler(async ({ context, input, errors }) => {
      if (!await reachableMachine(context, input.machineId) ||
          !await revokeMachine(context.env, context.userId, input.machineId)) {
        throw errors.NOT_FOUND();
      }
    }),
    deviceStart: os.machines.deviceStart.handler(({ context }) => startDeviceFlow(context.env)),
    devicePoll: os.machines.devicePoll.handler(({ context, input }) => pollDeviceFlow(context.env, input)),
    sync: os.machines.sync.use(auth).handler(async ({ context }) => {
      const machine = context.machine!; // `sync` accepts only Machine tokens.
      const [template, variables, openConflicts] = await Promise.all([
        getTemplate(context.env, context.userId),
        getVariables(context.env, machine.id),
        countOpenConflicts(context.env, context.userId),
      ]);
      return {
        machine,
        template,
        variables,
        openConflicts: { count: openConflicts, url: conflictsUrl(context.env) },
      };
    }),
  },
  variables: {
    get: os.variables.get.use(auth).handler(async ({ context, input, errors }) => {
      if (!await reachableMachine(context, input.machineId)) throw errors.NOT_FOUND();
      return getVariables(context.env, input.machineId);
    }),
    put: os.variables.put.use(auth).handler(async ({ context, input, errors }) => {
      if (!await reachableMachine(context, input.machineId)) throw errors.NOT_FOUND();
      const names = Object.keys(input.variables).filter((name) => !isSettableVariableName(name));
      if (names.length) throw errors.INVALID_VARIABLE_NAME({ data: { names } });
      const result = await putVariables(context.env, input.machineId, input.variables, input.expectedRevision);
      if (!result.ok) throw errors.CONFLICT({ data: { currentRevision: result.currentRevision } });
      return result.variables;
    }),
    history: os.variables.history.use(auth).handler(async ({ context, input, errors }) => {
      if (!await reachableMachine(context, input.machineId)) throw errors.NOT_FOUND();
      return variablesHistory(context.env, input.machineId);
    }),
  },
  conflicts: {
    create: os.conflicts.create.use(auth).handler(async ({ context, input, errors }) => {
      const created = await createConflict(context.env, context.userId, input.baseRevision, input.text);
      if (!created) throw errors.NOT_FOUND();
      return created;
    }),
    list: os.conflicts.list.use(auth).handler(({ context }) => listOpenConflicts(context.env, context.userId)),
    get: os.conflicts.get.use(auth).handler(async ({ context, input, errors }) => {
      const found = await getConflict(context.env, context.userId, input.conflictId);
      if (!found) throw errors.NOT_FOUND();
      return found;
    }),
    resolve: os.conflicts.resolve.use(auth).handler(async ({ context, input, errors }) => {
      const open = await getConflict(context.env, context.userId, input.conflictId);
      if (open?.status !== 'open') throw errors.NOT_FOUND();
      const issues = templateIssues(input.text, { resolving: true });
      if (issues.length) throw errors.INVALID_TEMPLATE({ data: { issues } });
      const result = await resolveConflict(context.env, context.userId, input.conflictId, input.text, input.expectedRevision);
      if (result.ok) return { conflict: result.conflict, template: result.template };
      if (result.reason === 'not_found') throw errors.NOT_FOUND();
      throw errors.CONFLICT({ data: { currentRevision: result.currentRevision } });
    }),
    discard: os.conflicts.discard.use(auth).handler(async ({ context, input, errors }) => {
      const discarded = await discardConflict(context.env, context.userId, input.conflictId);
      if (!discarded) throw errors.NOT_FOUND();
      return discarded;
    }),
  },
});

export type AppRouter = typeof router;

export function createRPCContext(request: Request, env: Env, session: AuthSession) {
  return { env, request, session } satisfies RPCContext;
}
