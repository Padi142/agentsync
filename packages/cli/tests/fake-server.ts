import { createHash, randomBytes } from 'node:crypto';
import {
  contract, normalizeSpacePath, SPACE_ERROR_STATUS, SPACE_LIMITS, spaceExpiresAt, spaceStatus, spaceWriterUpdateSchema,
  type Conflict, type DesiredSkill, type Machine, type PublicSpace, type ScannedSkill, type SkillSyncResult, type SpaceErrorCode,
  type SpaceEvent, type SpaceFile, type Target,
} from '@agentsync/contract';
import { hasConflictMarkers, validate } from '@agentsync/template';
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';

const SERVER = 'http://agentsync.test';

/** A Space as the fake server keeps it. Tests may reach in, e.g. to expire one or plant a bad path. */
export interface FakeSpace {
  id: string;
  title: string;
  summary: string | null;
  shareToken: string;
  writeToken: string;
  isPrivate: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  files: Map<string, Omit<SpaceFile, 'path'> & { bytes: Uint8Array<ArrayBuffer> }>;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * The fake end of a Space's WebSocket (`/s/<token>/ws`), standing in for Node's global `WebSocket`
 * (tests `vi.stubGlobal` it). It opens on the next tick, or closes without opening when the link
 * doesn't work or the server is offline.
 */
export interface FakeSocket extends EventTarget {
  readonly shareToken: string;
  open: boolean;
  close(): void;
}
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
    /** The Skills every Machine gets from `machines.sync`. */
    skills: [] as DesiredSkill[],
    /** Each `skills.report`, in order. */
    reports: [] as { machineId: string; scan: ScannedSkill[]; results?: SkillSyncResult[] }[],
    spaces: new Map<string, FakeSpace>(),
    /** Each Spaces HTTP request (`PUT /api/spaces/…`, `GET /s/…`), so tests can see what was uploaded or skipped. */
    spaceRequests: [] as string[],
    /** The Space WebSockets ever opened, open or closed. */
    sockets: [] as FakeSocket[],
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
        if (input.nickname) machine.nickname = input.nickname;
        if (input.hostname) machine.hostname = input.hostname;
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
          nickname: input.nickname,
          hostname: input.hostname,
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
          skills: state.skills,
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
    spaces: {
      create: os.spaces.create.handler(({ context, input }) => {
        machineOf(context.token);
        const now = new Date();
        const space: FakeSpace = {
          id: `space-${nextId++}`,
          title: input.title,
          summary: input.summary || null,
          shareToken: randomBytes(24).toString('base64url'),
          writeToken: `asw_${randomBytes(32).toString('base64url')}`,
          isPrivate: false,
          expiresAt: spaceExpiresAt(input.expires ?? `${SPACE_LIMITS.defaultDays}d`, now),
          createdAt: now,
          updatedAt: now,
          files: new Map(),
        };
        state.spaces.set(space.id, space);
        return { space: publicSpace(space), writeToken: space.writeToken };
      }),
      list: os.spaces.list.handler(sessionOnly),
      get: os.spaces.get.handler(sessionOnly),
      update: os.spaces.update.handler(sessionOnly),
      rotateLink: os.spaces.rotateLink.handler(sessionOnly),
      delete: os.spaces.delete.handler(sessionOnly),
      deleteFile: os.spaces.deleteFile.handler(sessionOnly),
    },
    skills: {
      overview: os.skills.overview.handler(sessionOnly),
      search: os.skills.search.handler(sessionOnly),
      audits: os.skills.audits.handler(sessionOnly),
      inspect: os.skills.inspect.handler(sessionOnly),
      collection: os.skills.collection.handler(sessionOnly),
      setIgnored: os.skills.setIgnored.handler(sessionOnly),
      add: os.skills.add.handler(sessionOnly),
      addMany: os.skills.addMany.handler(sessionOnly),
      assign: os.skills.assign.handler(sessionOnly),
      update: os.skills.update.handler(sessionOnly),
      updateAll: os.skills.updateAll.handler(sessionOnly),
      remove: os.skills.remove.handler(sessionOnly),
      setAutoUpdate: os.skills.setAutoUpdate.handler(sessionOnly),
      settings: os.skills.settings.handler(sessionOnly),
      history: os.skills.history.handler(sessionOnly),
      diff: os.skills.diff.handler(sessionOnly),
      report: os.skills.report.handler(({ context, input }) => {
        const machine = machineOf(context.token);
        state.reports.push({ machineId: machine.id, ...input });
      }),
    },
  });

  function publicSpace(space: FakeSpace): PublicSpace {
    const files = [...space.files].map(([path, { bytes: _, ...file }]) => ({ path, ...file }));
    return {
      id: space.id,
      title: space.title,
      summary: space.summary,
      status: spaceStatus(space),
      expiresAt: space.expiresAt,
      shareUrl: `${SERVER}/s/${space.shareToken}`,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      files,
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
    };
  }

  const fail = (code: SpaceErrorCode, message: string = code) =>
    Response.json({ error: { code, message } }, { status: SPACE_ERROR_STATUS[code] });

  /** Send `event` to every open socket of `space`, closing them after a `closed`. */
  function broadcast(space: FakeSpace, event: SpaceEvent | Record<string, unknown>) {
    for (const socket of state.sockets) {
      if (!socket.open || socket.shareToken !== space.shareToken) continue;
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
      if (event.type === 'closed') socket.close();
    }
  }

  /** The Write Token routes, as `SPACE_WRITER_ROUTES` describes them. */
  async function writerRoute(request: Request, segments: string[]): Promise<Response> {
    const [id, files, ...rest] = segments;
    const space = id ? state.spaces.get(id) : undefined;
    if (!space || request.headers.get('Authorization') !== `Bearer ${space.writeToken}`) return fail('UNAUTHORIZED');
    if (request.method === 'GET' && !files) return Response.json(publicSpace(space));
    if (spaceStatus(space) === 'expired') return fail('SPACE_EXPIRED', 'This Space has expired.');
    space.updatedAt = new Date();
    if (!files) {
      if (request.method === 'DELETE') {
        broadcast(space, { type: 'closed', reason: 'deleted' });
        state.spaces.delete(space.id);
        return new Response(null, { status: 204 });
      }
      const update = spaceWriterUpdateSchema.parse(await request.json());
      if (update.title !== undefined) space.title = update.title;
      if (update.summary !== undefined) space.summary = update.summary;
      if (update.expires !== undefined) space.expiresAt = spaceExpiresAt(update.expires);
      const { files: _, ...metadata } = publicSpace(space);
      broadcast(space, { type: 'space', space: metadata });
      return Response.json(publicSpace(space));
    }
    const path = rest.map(decodeURIComponent).join('/');
    if (normalizeSpacePath(path) !== path) return fail('INVALID_PATH');
    if (request.method === 'DELETE') {
      if (!space.files.delete(path)) return fail('NOT_FOUND');
      broadcast(space, { type: 'fileDeleted', path });
      return new Response(null, { status: 204 });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > SPACE_LIMITS.fileBytes) return fail('FILE_TOO_LARGE');
    const hash = sha256(bytes);
    const claimed = request.headers.get('X-Content-SHA256');
    if (claimed && claimed !== hash) return fail('INVALID_REQUEST', 'X-Content-SHA256 does not match the body.');
    const others = [...space.files].filter(([other]) => other !== path).reduce((sum, [, file]) => sum + file.size, 0);
    if (others + bytes.length > SPACE_LIMITS.spaceBytes) return fail('SPACE_FULL');
    const file = { size: bytes.length, contentType: request.headers.get('Content-Type') ?? 'application/octet-stream', sha256: hash, updatedAt: new Date() };
    space.files.set(path, { ...file, bytes });
    broadcast(space, { type: 'file', file: { path, ...file } });
    return Response.json({ path, ...file });
  }

  /** The Share Link routes the CLI reads: `.json` and `/raw/<path>`. */
  function publicRoute(request: Request, segments: string[]): Response {
    const [first = '', kind, ...rest] = segments;
    const shareToken = first.replace(/\.(json|md)$/, '');
    const space = [...state.spaces.values()].find((candidate) => candidate.shareToken === shareToken);
    if (!space || space.isPrivate) return fail('NOT_FOUND');
    if (spaceStatus(space) === 'expired') return fail('SPACE_EXPIRED');
    if (kind === undefined && (first.endsWith('.json') || request.headers.get('Accept')?.includes('application/json'))) {
      return Response.json(publicSpace(space));
    }
    const file = kind === 'raw' ? space.files.get(rest.map(decodeURIComponent).join('/')) : undefined;
    if (!file) return fail('NOT_FOUND');
    return new Response(file.bytes, { headers: { 'Content-Type': file.contentType } });
  }

  /** A `WebSocket` constructor bound to this server. */
  class WebSocket extends EventTarget implements FakeSocket {
    readonly shareToken: string;
    open = false;
    ended = false;
    constructor(url: string) {
      super();
      this.shareToken = new URL(url).pathname.split('/')[2] ?? '';
      state.sockets.push(this);
      setTimeout(() => {
        if (this.ended) return;
        const space = [...state.spaces.values()].find((candidate) => candidate.shareToken === this.shareToken);
        if (state.offline || !space || space.isPrivate || spaceStatus(space) === 'expired') {
          this.dispatchEvent(new Event('error'));
          return this.close();
        }
        this.open = true;
        this.dispatchEvent(new Event('open'));
      });
    }
    close() {
      if (this.ended) return;
      this.ended = true;
      this.open = false;
      setTimeout(() => this.dispatchEvent(new Event('close')));
    }
  }

  const handler = new RPCHandler(router);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (state.offline || [...state.down].some((path) => request.url.endsWith(path))) throw new TypeError('fetch failed');
    state.requests.push(request.headers);
    const { pathname } = new URL(request.url);
    const [, area, sub, ...segments] = pathname.split('/');
    if (area === 'api' && sub === 'spaces') {
      state.spaceRequests.push(`${request.method} ${pathname}`);
      return writerRoute(request, segments);
    }
    if (area === 's' && sub) {
      state.spaceRequests.push(`${request.method} ${pathname}`);
      return publicRoute(request, [sub, ...segments]);
    }
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
    const { matched, response } = await handler.handle(request, { prefix: '/rpc', context: { token } });
    return matched ? response : new Response('Not found', { status: 404 });
  };

  /** Register a Machine directly, as if `init` had already run on it. */
  const register = (name: string, targets: Target[]) => {
    const machine: Machine = { id: `machine-${nextId++}`, nickname: name, hostname: name, os: 'linux', targets, createdAt: new Date(), lastSeenAt: null };
    const token = `token-${nextId++}`;
    state.machines.set(machine.id, machine);
    state.tokens.set(token, machine.id);
    return { machine, token };
  };

  /** Drop every open Space socket, as a lost connection would (no `closed` event). */
  const dropSockets = () => {
    for (const socket of state.sockets) socket.close();
  };

  return { url: SERVER, state, fetch, register, putTemplate, WebSocket, broadcast, dropSockets };
}
