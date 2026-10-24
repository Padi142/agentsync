import {
  oc,
  type ContractRouterClient,
  type InferContractRouterInputs,
  type InferContractRouterOutputs,
} from '@orpc/contract';
import { z } from 'zod';

/**
 * How a caller proves who it is.
 * - `session`: the WorkOS AuthKit session cookie of a signed-in browser.
 * - `machine`: a per-Machine token sent as `Authorization: Bearer <token>`.
 *   A Machine token only reaches its own Machine; other Machines are `NOT_FOUND`.
 */
export type AuthKind = 'session' | 'machine';

/** Every procedure lists the auth kinds it accepts. An empty list means public. */
export interface ProcedureMeta {
  auth: readonly AuthKind[];
}

// Schemas

const id = z.string().min(1);

/** A head revision. `0` means nothing has been saved yet. */
const revision = z.number().int().min(0);
const savedRevision = z.number().int().min(1);

const templateText = z.string().max(500_000);

export const templateSchema = z.object({
  text: templateText,
  revision,
  updatedAt: z.date().nullable(),
});

export const templateRevisionSchema = z.object({
  revision: savedRevision,
  text: templateText,
  createdAt: z.date(),
});

export const revisionSummarySchema = z.object({
  revision: savedRevision,
  createdAt: z.date(),
});

export const machineOsSchema = z.enum(['macos', 'linux', 'windows']);

/** `agent` is the value of the `agent` Built-in Variable when Rendering this Target. */
export const targetSchema = z.object({
  path: z.string().trim().min(1).max(500),
  agent: z.string().regex(/^[a-z][a-z0-9-]*$/).max(32),
});

const machineName = z.string().trim().min(1).max(100);

export const machineSchema = z.object({
  id,
  name: machineName,
  os: machineOsSchema,
  targets: z.array(targetSchema).max(20),
  createdAt: z.date(),
  lastSeenAt: z.date().nullable(),
});

/** Variable names are checked against the grammar by the server, not here. */
export const variableMapSchema = z.record(z.string().min(1).max(100), z.string().max(10_000));

export const machineVariablesSchema = z.object({
  machineId: id,
  variables: variableMapSchema,
  revision,
});

export const variablesRevisionSchema = z.object({
  revision: savedRevision,
  variables: variableMapSchema,
  createdAt: z.date(),
});

export const conflictStatusSchema = z.enum(['open', 'resolved', 'discarded']);

/** `text` is the Template with git-style `<<<<<<<`/`=======`/`>>>>>>>` markers. */
export const conflictSchema = z.object({
  id,
  baseRevision: revision,
  serverRevision: savedRevision,
  text: z.string().max(1_000_000),
  status: conflictStatusSchema,
  url: z.url(),
  createdAt: z.date(),
  closedAt: z.date().nullable(),
});

export const userSchema = z.object({
  id,
  name: z.string(),
  email: z.string(),
});

export const deviceAuthorizationSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.url(),
  verificationUriComplete: z.url(),
  /** Seconds until `deviceCode` expires. */
  expiresIn: z.number().int().positive(),
  /** Seconds to wait between polls. */
  interval: z.number().int().positive(),
});

export const devicePollResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), interval: z.number().int().positive() }),
  /** `token` is returned exactly once; the server keeps only its hash. */
  z.object({ status: z.literal('approved'), token: z.string().min(1), machine: machineSchema }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('denied') }),
]);

export const syncPayloadSchema = z.object({
  machine: machineSchema,
  template: templateSchema,
  variables: machineVariablesSchema,
  openConflicts: z.object({
    count: z.number().int().min(0),
    url: z.url(),
  }),
});

/** A syntax error in a Template, or a Conflict marker left in a resolution. Lines and columns start at 1. */
export const templateIssueSchema = z.object({
  message: z.string(),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
});

// Errors

const conflictError = {
  CONFLICT: {
    status: 409,
    message: 'The revision changed since this edit began.',
    data: z.object({ currentRevision: revision }),
  },
};
const notFoundError = { NOT_FOUND: { status: 404 } };
const invalidTemplateError = {
  INVALID_TEMPLATE: {
    status: 422,
    message: 'The Template does not parse.',
    data: z.object({ issues: z.array(templateIssueSchema) }),
  },
};
const invalidVariableNameError = {
  INVALID_VARIABLE_NAME: {
    status: 422,
    message: 'Some Variable names are invalid or reserved for Built-in Variables.',
    data: z.object({ names: z.array(z.string()) }),
  },
};

// Procedures

const base = oc.$meta<ProcedureMeta>({ auth: [] });
const unauthorized = { UNAUTHORIZED: { status: 401 } };
const publicProcedure = base;
const sessionProcedure = base.meta({ auth: ['session'] }).errors(unauthorized);
const machineProcedure = base.meta({ auth: ['machine'] }).errors(unauthorized);
const anyAuthProcedure = base.meta({ auth: ['session', 'machine'] }).errors(unauthorized);

const machineIdInput = z.object({ machineId: id });

const template = {
  /** The current Template. Revision `0` with empty text means none has been saved yet. */
  get: anyAuthProcedure.output(templateSchema),
  /** Save a new Template revision. Use `expectedRevision: 0` for the first one. */
  put: anyAuthProcedure
    .input(z.object({ text: templateText, expectedRevision: revision }))
    .output(templateSchema)
    .errors({ ...conflictError, ...invalidTemplateError }),
  /** Every saved revision, newest first, without text. */
  history: sessionProcedure.output(z.array(revisionSummarySchema)),
  revision: sessionProcedure
    .input(z.object({ revision: savedRevision }))
    .output(templateRevisionSchema)
    .errors(notFoundError),
  /** Save a new revision whose text is copied from `revision`. */
  rollback: sessionProcedure
    .input(z.object({ revision: savedRevision, expectedRevision: revision }))
    .output(templateSchema)
    .errors({ ...notFoundError, ...conflictError }),
};

const machines = {
  list: sessionProcedure.output(z.array(machineSchema)),
  get: sessionProcedure.input(machineIdInput).output(machineSchema).errors(notFoundError),
  update: anyAuthProcedure
    .input(
      machineIdInput.extend({
        name: machineName.optional(),
        targets: z.array(targetSchema).max(20).optional(),
      }),
    )
    .output(machineSchema)
    .errors(notFoundError),
  /** Delete the Machine and its token. A Machine token may revoke only itself. */
  revoke: anyAuthProcedure.input(machineIdInput).output(z.void()).errors(notFoundError),
  /** Start the WorkOS AuthKit CLI Auth device flow. */
  deviceStart: publicProcedure.output(deviceAuthorizationSchema),
  /** Poll the device flow. On approval, registers the Machine and returns its token once. */
  devicePoll: publicProcedure
    .input(
      z.object({
        deviceCode: z.string().min(1),
        name: machineName,
        os: machineOsSchema,
        targets: z.array(targetSchema).max(20),
      }),
    )
    .output(devicePollResultSchema),
  /** Everything the calling Machine needs to Render its Targets, in one round-trip. */
  sync: machineProcedure.output(syncPayloadSchema),
};

const variables = {
  /** A Machine's Variables. Revision `0` with an empty map means none have been saved yet. */
  get: anyAuthProcedure.input(machineIdInput).output(machineVariablesSchema).errors(notFoundError),
  /** Replace a Machine's whole Variable map. */
  put: anyAuthProcedure
    .input(machineIdInput.extend({ variables: variableMapSchema, expectedRevision: revision }))
    .output(machineVariablesSchema)
    .errors({ ...notFoundError, ...conflictError, ...invalidVariableNameError }),
  /** Every saved revision with its full map, newest first. Roll back by `put`ting an old map. */
  history: sessionProcedure
    .input(machineIdInput)
    .output(z.array(variablesRevisionSchema))
    .errors(notFoundError),
};

const conflictIdInput = z.object({ conflictId: id });

const conflicts = {
  /** Keep an edit that failed with `CONFLICT`. The server builds the marked text. */
  create: anyAuthProcedure
    .input(z.object({ baseRevision: revision, text: templateText }))
    .output(conflictSchema),
  /** Open Conflicts, oldest first. */
  list: anyAuthProcedure.output(z.array(conflictSchema)),
  get: anyAuthProcedure.input(conflictIdInput).output(conflictSchema).errors(notFoundError),
  /**
   * Save `text` as a new Template revision and close the Conflict.
   * Fails with `CONFLICT` if the Template moved past `serverRevision`, and
   * `NOT_FOUND` if the Conflict is not open.
   */
  resolve: anyAuthProcedure
    .input(conflictIdInput.extend({ text: templateText }))
    .output(z.object({ conflict: conflictSchema, template: templateSchema }))
    .errors({ ...notFoundError, ...conflictError, ...invalidTemplateError }),
  discard: sessionProcedure.input(conflictIdInput).output(conflictSchema).errors(notFoundError),
};

export const contract = {
  health: publicProcedure.output(z.object({ ok: z.literal(true) })),
  /** The signed-in browser user, or `null`. */
  session: publicProcedure.output(userSchema.nullable()),
  template,
  machines,
  variables,
  conflicts,
};

export type Contract = typeof contract;
/** The typed client for the CLI and the web app, e.g. `createORPCClient<ContractClient>(link)`. */
export type ContractClient = ContractRouterClient<Contract>;
export type ContractInputs = InferContractRouterInputs<Contract>;
export type ContractOutputs = InferContractRouterOutputs<Contract>;

export type Template = z.infer<typeof templateSchema>;
export type TemplateRevision = z.infer<typeof templateRevisionSchema>;
export type RevisionSummary = z.infer<typeof revisionSummarySchema>;
export type MachineOs = z.infer<typeof machineOsSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Machine = z.infer<typeof machineSchema>;
export type VariableMap = z.infer<typeof variableMapSchema>;
export type MachineVariables = z.infer<typeof machineVariablesSchema>;
export type VariablesRevision = z.infer<typeof variablesRevisionSchema>;
export type ConflictStatus = z.infer<typeof conflictStatusSchema>;
export type Conflict = z.infer<typeof conflictSchema>;
export type User = z.infer<typeof userSchema>;
export type DeviceAuthorization = z.infer<typeof deviceAuthorizationSchema>;
export type DevicePollResult = z.infer<typeof devicePollResultSchema>;
export type SyncPayload = z.infer<typeof syncPayloadSchema>;
export type TemplateIssue = z.infer<typeof templateIssueSchema>;
