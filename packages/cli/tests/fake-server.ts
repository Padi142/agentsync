import { contract, type Conflict, type Machine, type Target } from '@agentsync/contract';
import { hasConflictMarkers, validate } from '@agentsync/template';
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';

const SERVER = 'http://agentsync.test';
const os = implement(contract).$context<{ token: string | undefined }>();

/**
 * An in-memory AgentSync server for one user, built from the contract. `fetch` is what the
 * CLI is given; `requests` records each request's headers so tests can check what the CLI sends.
 */
export function fakeServer() {
  const state = {
    template: { text: '', revision: 0, updatedAt: null as Date | null },
    machines: new Map<string, Machine>(),
    tokens: new Map<string, string>(),
    variables: new Map<string, { variables: Record<string, string>; revision: number }>(),
    conflicts: [] as Conflict[],
    /** What the next poll of each device code answers. */
    devices: new Map<string, 'pending' | 'approved' | 'denied' | 'expired' | 'used'>(),
    /** How the next device flow ends: `pending` answers one `pending` poll before approving. */
    nextDevice: 'approved' as 'pending' | 'approved' | 'denied' | 'expired' | 'used',
    offline: false,
    /** Procedures (e.g. `/template/put`) whose requests fail like a dropped connection. */
    down: new Set<string>(),
    requests: [] as Headers[],
  };
  let nextId = 1;

  const machineOf = (token: string | undefined) => {
    const id = token && state.tokens.get(token);
    const machine = id && state.machines.get(id);
    if (!machine) throw new ORPCError('UNAUTHORIZED');
    return machine;
  };
  const own = (token: string | undefined, machineId: string) => {
    if (machineOf(token).id !== machineId) throw new ORPCError('NOT_FOUND');
    return state.machines.get(machineId)!;
  };
  const variablesOf = (machineId: string) =>
    state.variables.get(machineId) ?? { variables: {}, revision: 0 };
  const sessionOnly = () => {
    throw new ORPCError('UNAUTHORIZED');
  };
  const putTemplate = (text: string) => {
    state.template = { text, revision: state.template.revision + 1, updatedAt: new Date() };
    return state.template;
  };
  const issuesOf = (text: string) => {
    const error = validate(text);
    return error ? [{ message: error.message, line: error.line, column: error.column }] : [];
  };

  const router = os.router({
    health: os.health.handler(() => ({ ok: true as const })),
    session: os.session.handler(() => null),
    template: {
      get: os.template.get.handler(({ context }) => (machineOf(context.token), state.template)),
      put: os.template.put.handler(({ context, input, errors }) => {
        machineOf(context.token);
        const issues = issuesOf(input.text);
        if (issues.length) throw errors.INVALID_TEMPLATE({ data: { issues } });
        if (input.expectedRevision !== state.template.revision) {
          throw errors.CONFLICT({ data: { currentRevision: state.template.revision } });
        }
        return putTemplate(input.text);
      }),
      history: os.template.history.handler(sessionOnly),
      revision: os.template.revision.handler(sessionOnly),
      rollback: os.template.rollback.handler(sessionOnly),
    },
    machines: {
      list: os.machines.list.handler(sessionOnly),
      get: os.machines.get.handler(sessionOnly),
      update: os.machines.update.handler(({ context, input }) => {
        const machine = own(context.token, input.machineId);
        if (input.name) machine.name = input.name;
        if (input.targets) machine.targets = input.targets;
        return machine;
      }),
      revoke: os.machines.revoke.handler(({ context, input }) => {
        own(context.token, input.machineId);
        state.machines.delete(input.machineId);
        for (const [token, id] of state.tokens) if (id === input.machineId) state.tokens.delete(token);
      }),
      deviceStart: os.machines.deviceStart.handler(() => {
        const deviceCode = `device-${nextId++}`;
        state.devices.set(deviceCode, state.nextDevice);
        return {
          deviceCode,
          userCode: 'ABCD-EFGH',
          verificationUri: `${SERVER}/device`,
          verificationUriComplete: `${SERVER}/device?code=ABCD-EFGH`,
          expiresIn: 300,
          interval: 1,
        };
      }),
      devicePoll: os.machines.devicePoll.handler(({ input }) => {
        const status = state.devices.get(input.deviceCode);
        if (status === 'pending') {
          state.devices.set(input.deviceCode, 'approved');
          return { status: 'pending' as const, interval: 7 };
        }
        if (status === 'denied' || status === 'expired') return { status };
        if (status !== 'approved') return { status: 'invalid' as const };
        state.devices.set(input.deviceCode, 'used');
        const machine: Machine = {
          id: `machine-${nextId++}`,
          name: input.name,
          os: input.os,
          targets: input.targets,
          createdAt: new Date(),
          lastSeenAt: null,
        };
        const token = `token-${nextId++}`;
        state.machines.set(machine.id, machine);
        state.tokens.set(token, machine.id);
        return { status: 'approved' as const, token, machine };
      }),
      sync: os.machines.sync.handler(({ context }) => {
        const machine = machineOf(context.token);
        const open = state.conflicts.filter((conflict) => conflict.status === 'open');
        return {
          machine,
          template: state.template,
          variables: { machineId: machine.id, ...variablesOf(machine.id) },
          openConflicts: { count: open.length, url: `${SERVER}/conflicts` },
        };
      }),
    },
    variables: {
      get: os.variables.get.handler(({ context, input }) => {
        own(context.token, input.machineId);
        return { machineId: input.machineId, ...variablesOf(input.machineId) };
      }),
      put: os.variables.put.handler(({ context, input, errors }) => {
        own(context.token, input.machineId);
        const current = variablesOf(input.machineId);
        if (input.expectedRevision !== current.revision) {
          throw errors.CONFLICT({ data: { currentRevision: current.revision } });
        }
        const saved = { variables: input.variables, revision: current.revision + 1 };
        state.variables.set(input.machineId, saved);
        return { machineId: input.machineId, ...saved };
      }),
      history: os.variables.history.handler(sessionOnly),
    },
    conflicts: {
      create: os.conflicts.create.handler(({ context, input }) => {
        machineOf(context.token);
        const id = `conflict-${nextId++}`;
        const conflict: Conflict = {
          id,
          baseRevision: input.baseRevision,
          serverRevision: state.template.revision,
          text: `<<<<<<< server\n${state.template.text}=======\n${input.text}>>>>>>> edit\n`,
          status: 'open',
          url: `${SERVER}/conflicts/${id}`,
          createdAt: new Date(),
          closedAt: null,
        };
        state.conflicts.push(conflict);
        return conflict;
      }),
      list: os.conflicts.list.handler(({ context }) => {
        machineOf(context.token);
        return state.conflicts.filter((conflict) => conflict.status === 'open');
      }),
      get: os.conflicts.get.handler(({ context, input, errors }) => {
        machineOf(context.token);
        const conflict = state.conflicts.find((candidate) => candidate.id === input.conflictId);
        if (!conflict) throw errors.NOT_FOUND();
        return conflict;
      }),
      resolve: os.conflicts.resolve.handler(({ context, input, errors }) => {
        machineOf(context.token);
        const conflict = state.conflicts.find((candidate) => candidate.id === input.conflictId);
        if (conflict?.status !== 'open') throw errors.NOT_FOUND();
        const issues = issuesOf(input.text);
        if (hasConflictMarkers(input.text)) issues.push({ message: 'Conflict marker left', line: 1, column: 1 });
        if (issues.length) throw errors.INVALID_TEMPLATE({ data: { issues } });
        if (input.expectedRevision !== state.template.revision) {
          throw errors.CONFLICT({ data: { currentRevision: state.template.revision } });
        }
        conflict.status = 'resolved';
        conflict.closedAt = new Date();
        return { conflict, template: putTemplate(input.text) };
      }),
      discard: os.conflicts.discard.handler(sessionOnly),
    },
  });

  const handler = new RPCHandler(router);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (state.offline || [...state.down].some((path) => request.url.endsWith(path))) throw new TypeError('fetch failed');
    state.requests.push(request.headers);
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
    const { matched, response } = await handler.handle(request, { prefix: '/rpc', context: { token } });
    return matched ? response : new Response('Not found', { status: 404 });
  };

  /** Register a Machine directly, as if `init` had already run on it. */
  const register = (name: string, targets: Target[]) => {
    const machine: Machine = { id: `machine-${nextId++}`, name, os: 'linux', targets, createdAt: new Date(), lastSeenAt: null };
    const token = `token-${nextId++}`;
    state.machines.set(machine.id, machine);
    state.tokens.set(token, machine.id);
    return { machine, token };
  };

  return { url: SERVER, state, fetch, register, putTemplate };
}
