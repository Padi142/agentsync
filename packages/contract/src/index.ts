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

/** A head revision. `0` is the empty initial Template (or Variable map) before anything is saved. */
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

/** The CLI normalises its platform to one of these, e.g. Node's `darwin` becomes `macos`. */
export const machineOsSchema = z.enum(['macos', 'linux', 'windows']);

/** `agent` is the value of the `agent` Built-in Variable when Rendering this Target. */
export const targetSchema = z.object({
  path: z.string().trim().min(1).max(500),
  agent: z.string().regex(/^[a-z][a-z0-9-]*$/).max(32),
});

/** A Machine nickname, the name a person gives it: trimmed, 1–100 characters. Spaces, Unicode and duplicates are fine. */
export const machineNicknameSchema = z.string().trim().min(1).max(100);
/** The computer's own hostname, as the CLI reports it. Only the Machine itself can change it. */
export const machineHostnameSchema = z.string().trim().min(1).max(255);

export const machineSchema = z.object({
  id,
  nickname: machineNicknameSchema,
  hostname: machineHostnameSchema,
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

/**
 * `text` is the Template with git-style `<<<<<<<`/`=======`/`>>>>>>>` markers.
 * It holds both sides plus markers, so it is not capped like a Template.
 * `serverRevision` records the head when the Conflict was created.
 */
export const conflictSchema = z.object({
  id,
  baseRevision: revision,
  serverRevision: savedRevision,
  text: z.string(),
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

/**
 * Registration is single-use: the first `approved` response creates the Machine
 * and returns its token, and the server keeps only the token's hash. Any later
 * poll with the same code, including a retry after that response was lost,
 * gets `invalid` and never a second token or Machine.
 */
export const devicePollResultSchema = z.discriminatedUnion('status', [
  /** Wait `interval` seconds before the next poll. It already includes any WorkOS `slow_down` increase. */
  z.object({ status: z.literal('pending'), interval: z.number().int().positive() }),
  z.object({ status: z.literal('approved'), token: z.string().min(1), machine: machineSchema }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('denied') }),
  /** The code is unknown or was already used. */
  z.object({ status: z.literal('invalid') }),
]);

// Skills

/**
 * A Skill name: the `name` in its `SKILL.md` frontmatter, which is also its folder and lock key on a
 * Machine. It never starts with `-`, so it can't be read as a flag of the `skills` CLI.
 */
export const skillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** The CLI's own skill: no Skill may take its name. */
export const RESERVED_SKILL_NAME = 'agentsync';
/** A public GitHub repository as `owner/repo`. Neither part may start with `-` or be `.`/`..`. */
export const repoNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/);
/** A full git object ID: a commit, or a tree hash. */
export const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * What `skills` 1.7.4 leaves out when it copies a skill folder: files with these names at any depth,
 * and directories with these names. Both the server (from GitHub's tree) and the CLI (from disk) skip
 * them when they hash a folder, so the hashes agree. Bump with the `skills` version.
 */
export const SKILL_COPY_EXCLUDES = {
  files: ['metadata.json'],
  dirs: ['.git', '__pycache__', '__pypackages__'],
} as const;

/** A repository on GitHub. `id` survives renames; `fullName` is the canonical `owner/repo` now. */
export const skillRepoSchema = z.object({
  id: z.number().int().positive(),
  fullName: repoNameSchema,
});

/**
 * The exact version a Skill installs. `treeSha` is GitHub's tree for the folder at `commit` (what the
 * `skills` lock records); `installedHash` is the git tree hash of what `skills` writes to disk, which
 * differs when it leaves files out (`SKILL_COPY_EXCLUDES`). Skill Drift compares a folder to `installedHash`.
 */
export const pinSchema = z.object({
  commit: gitShaSchema,
  treeSha: gitShaSchema,
  installedHash: gitShaSchema,
  /** When `commit` was made, for display. Commit dates are set by the author, so never trust them for anything else. */
  committedAt: z.date(),
});

export const auditRiskSchema = z.enum(['safe', 'low', 'medium', 'high', 'critical']);

/** One scanner's verdict from skills.sh. Verdicts are per Skill, not per commit. */
export const auditSchema = z.object({
  risk: auditRiskSchema,
  analyzedAt: z.date(),
});

/** The three skills.sh scanners. `gen` is skills.sh's own (`ath` in its API). `null`: no verdict. */
export const auditsSchema = z.object({
  gen: auditSchema.nullable(),
  socket: auditSchema.nullable(),
  snyk: auditSchema.nullable(),
});

/**
 * A newer version of a Skill's folder on the repository's default branch.
 * `audited` follows the hold-back rule: all three verdicts exist and each was made after
 * the push that brought `pin.commit`. Only an audited candidate rated below High updates automatically.
 */
export const skillUpdateSchema = z.object({
  pin: pinSchema,
  audits: auditsSchema,
  audited: z.boolean(),
});

/**
 * Where a Skill stands on one Machine:
 * - `installed`: its folder matches the Pin.
 * - `pending`: `skills sync` has something to do here: `install`, `update` (an older Pin is installed) or `remove`.
 * - `failed`: the last `skills sync` could not install it.
 * - `blocked`: a folder of the same name that AgentSync doesn't manage is in the way.
 * - `drifted`: the managed folder was edited by hand.
 * - `newer`: the folder matches a newer commit of the same repository; the Pin can move to it.
 * - `not-set`: not assigned to this Machine, and nothing to remove.
 */
export const machineSkillStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('installed') }),
  z.object({ status: z.literal('pending'), change: z.enum(['install', 'update', 'remove']) }),
  z.object({ status: z.literal('failed'), error: z.string(), at: z.date() }),
  z.object({ status: z.literal('blocked') }),
  z.object({ status: z.literal('drifted') }),
  z.object({ status: z.literal('newer'), commit: gitShaSchema, committedAt: z.date() }),
  z.object({ status: z.literal('not-set') }),
]);

export const skillAssignmentSchema = z.discriminatedUnion('to', [
  /** Every Machine, including ones registered later. */
  z.object({ to: z.literal('all') }),
  z.object({ to: z.literal('chosen'), machineIds: z.array(id).max(200) }),
]);

export const skillSchema = z.object({
  id,
  name: skillNameSchema,
  repo: skillRepoSchema,
  /** The folder in the repository, e.g. `skills/animate`; `''` for the root. */
  path: z.string().max(500),
  pin: pinSchema,
  assignment: skillAssignmentSchema,
  /** `false` puts the Skill on the ignore list: it never updates automatically. */
  autoUpdate: z.boolean(),
  update: skillUpdateSchema.nullable(),
  /** One entry per Machine of the account. */
  machines: z.array(machineSkillStateSchema.and(z.object({ machineId: id }))),
  createdAt: z.date(),
});

/**
 * A skill a scan saw on a Machine that is not a Skill in the account. `github` ones came from the
 * `skills` lock with that source and can be added; `local` ones (hand-written, or from another kind
 * of source) are reported by name only.
 */
export const foundSkillSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github'),
    name: skillNameSchema,
    /** As the Machine's lock records it, which may be a repository's old name. */
    source: repoNameSchema,
    machines: z.array(z.object({ machineId: id, ref: gitShaSchema.nullable() })),
  }),
  z.object({ kind: z.literal('local'), name: z.string(), machineIds: z.array(id) }),
]);

export const skillSettingsSchema = z.object({
  /** Move Pins to new audited versions rated below High without asking. Off by default. */
  autoUpdate: z.boolean(),
});

export const skillsOverviewSchema = z.object({
  settings: skillSettingsSchema,
  skills: z.array(skillSchema),
  found: z.array(foundSkillSchema),
  /** When each Machine last reported its Skills; `null` if it never has. */
  machines: z.array(z.object({ id, nickname: machineNicknameSchema, checkedInAt: z.date().nullable() })),
});

export const pinMoveSchema = z.object({
  /** `null` when the Skill was added. */
  from: gitShaSchema.nullable(),
  to: gitShaSchema,
  kind: z.enum(['added', 'manual', 'automatic']),
  /** The verdicts when the Pin moved. */
  audits: auditsSchema,
  at: z.date(),
});

export const skillSearchResultSchema = z.object({
  name: z.string(),
  source: z.string(),
  installs: z.number().int().min(0),
});

/** A Skill as it is now on GitHub, before it is added: for the Add dialog's preview. */
export const skillCandidateSchema = z.object({
  name: skillNameSchema,
  repo: skillRepoSchema,
  path: z.string(),
  pin: pinSchema,
  audits: auditsSchema,
});

export const skillFileChangeSchema = z.object({
  /** Relative to the Skill's folder. */
  path: z.string(),
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  /** A unified diff of this file; missing when GitHub leaves it out (binary or too large). */
  patch: z.string().optional(),
});

export const skillDiffSchema = z.object({
  base: gitShaSchema,
  head: gitShaSchema,
  files: z.array(skillFileChangeSchema),
  /** GitHub caps a comparison at 300 files. */
  truncated: z.boolean(),
});

/** A Skill a Machine should have: what `agentsync skills sync` installs with `skills add <repo>#<commit>`. */
export const desiredSkillSchema = z.object({
  name: skillNameSchema,
  repo: repoNameSchema,
  commit: gitShaSchema,
  installedHash: gitShaSchema,
});

/**
 * One skill folder on a Machine (in `~/.agents/skills` or the Claude Code skills directory).
 * `source` is the `skills` lock's source, or `null` for a hand-written folder; `hash` is the git
 * tree hash on disk (`null` for hand-written folders, which report their name only, or when two
 * copies disagree). `managed`: AgentSync installed or adopted it.
 */
export const scannedSkillSchema = z.object({
  name: z.string().min(1).max(255),
  source: z.string().max(300).nullable(),
  ref: z.string().max(100).nullable(),
  hash: gitShaSchema.nullable(),
  managed: z.boolean(),
});

/** What the last `agentsync skills sync` did with one Skill. */
export const skillSyncResultSchema = z.object({
  name: skillNameSchema,
  commit: gitShaSchema,
  status: z.enum(['installed', 'updated', 'adopted', 'removed', 'unchanged', 'failed', 'blocked', 'drifted']),
  error: z.string().max(2000).optional(),
});

export const syncPayloadSchema = z.object({
  machine: machineSchema,
  template: templateSchema,
  variables: machineVariablesSchema,
  openConflicts: z.object({
    count: z.number().int().min(0),
    url: z.url(),
  }),
  /** The Skills this Machine should have. Only `agentsync skills sync` acts on them. */
  skills: z.array(desiredSkillSchema),
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

const skillErrors = {
  NOT_FOUND: { status: 404 },
  /** The repository or folder can't be a Skill: private, a symlink or submodule inside, no SKILL.md, a bad name. */
  UNSUPPORTED_SKILL: { status: 422, data: z.object({ reason: z.string() }) },
  /** Another Skill in the account already has this name. */
  SKILL_NAME_TAKEN: { status: 409 },
  /** The Machine's copy matches no version of the folder on the default branch. */
  NO_MATCHING_COMMIT: { status: 422 },
  /** GitHub or skills.sh did not answer, or GitHub's rate limit is used up. Try again later. */
  UPSTREAM_UNAVAILABLE: { status: 503 },
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
        nickname: machineNicknameSchema.optional(),
        /** Only a Machine token may change its own hostname; a browser session gets FORBIDDEN. */
        hostname: machineHostnameSchema.optional(),
        targets: z.array(targetSchema).max(20).optional(),
      }),
    )
    .output(machineSchema)
    .errors(notFoundError),
  /** Delete the Machine and its token. A Machine token may revoke only itself. */
  revoke: anyAuthProcedure.input(machineIdInput).output(z.void()).errors(notFoundError),
  /** Start the WorkOS AuthKit CLI Auth device flow. */
  deviceStart: publicProcedure.output(deviceAuthorizationSchema),
  /** Poll the device flow. On approval, registers the Machine and returns its token once (see `devicePollResultSchema`). */
  devicePoll: publicProcedure
    .input(
      z.object({
        deviceCode: z.string().min(1),
        nickname: machineNicknameSchema,
        hostname: machineHostnameSchema,
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
  /**
   * Keep an edit that failed with `CONFLICT`. The server builds the marked text.
   * `baseRevision` is the revision the edit started from; `0` means the empty
   * initial Template. A revision missing from the user's history is `NOT_FOUND`.
   */
  create: anyAuthProcedure
    .input(z.object({ baseRevision: revision, text: templateText }))
    .output(conflictSchema)
    .errors(notFoundError),
  /** Open Conflicts, oldest first. */
  list: anyAuthProcedure.output(z.array(conflictSchema)),
  get: anyAuthProcedure.input(conflictIdInput).output(conflictSchema).errors(notFoundError),
  /**
   * Save `text` as a new Template revision and close the Conflict.
   * `expectedRevision` is the Template head the resolution was merged against;
   * the server compares it to the current head atomically. On `CONFLICT`,
   * re-fetch the Template, merge again and retry. `NOT_FOUND` if the Conflict is not open.
   */
  resolve: anyAuthProcedure
    .input(conflictIdInput.extend({ text: templateText, expectedRevision: revision }))
    .output(z.object({ conflict: conflictSchema, template: templateSchema }))
    .errors({ ...notFoundError, ...conflictError, ...invalidTemplateError }),
  discard: sessionProcedure.input(conflictIdInput).output(conflictSchema).errors(notFoundError),
};

const skillIdInput = z.object({ skillId: id });

/** Skills are changed only from a signed-in browser. A Machine reads its own list (in `machines.sync`) and reports. */
const skills = {
  /** Everything the Skills page shows, in one call. */
  overview: sessionProcedure.output(skillsOverviewSchema),
  /** Search skills.sh. */
  search: sessionProcedure
    .input(z.object({ query: z.string().trim().min(1).max(100) }))
    .output(z.array(skillSearchResultSchema))
    .errors(skillErrors),
  /** The newest version of a skill on GitHub with its audits, without adding it. */
  inspect: sessionProcedure
    .input(z.object({ repo: repoNameSchema, name: skillNameSchema }))
    .output(skillCandidateSchema)
    .errors(skillErrors),
  /**
   * Add a Skill, assigned to every Machine. With `machineId` (a Found Skill), pin the commit that
   * Machine already has, so nothing is reinstalled; otherwise the newest on the default branch.
   */
  add: sessionProcedure
    .input(z.object({ repo: repoNameSchema, name: skillNameSchema, machineId: id.optional() }))
    .output(skillSchema)
    .errors(skillErrors),
  assign: sessionProcedure
    .input(skillIdInput.extend({ assignment: skillAssignmentSchema }))
    .output(skillSchema)
    .errors(skillErrors),
  /**
   * Move the Pin to `commit`, which must be a version of the folder on the default branch
   * (the update candidate, or a newer version a Machine has). Recorded in the history.
   */
  update: sessionProcedure
    .input(skillIdInput.extend({ commit: gitShaSchema }))
    .output(skillSchema)
    .errors(skillErrors),
  /** Move every Skill with an update candidate to it. Returns how many moved. */
  updateAll: sessionProcedure.output(z.object({ updated: z.number().int().min(0) })),
  /** Remove the Skill from the account. `skills sync` then removes undrifted copies from Machines. */
  remove: sessionProcedure.input(skillIdInput).output(z.void()).errors(skillErrors),
  /** Put a Skill on, or take it off, the ignore list for automatic updates. */
  setAutoUpdate: sessionProcedure
    .input(skillIdInput.extend({ autoUpdate: z.boolean() }))
    .output(skillSchema)
    .errors(skillErrors),
  settings: sessionProcedure.input(skillSettingsSchema).output(skillSettingsSchema),
  /** Every Pin move, newest first. */
  history: sessionProcedure.input(skillIdInput).output(z.array(pinMoveSchema)).errors(skillErrors),
  /** What changed in the Skill's folder between two commits (default: the Pin and the update candidate). */
  diff: sessionProcedure
    .input(skillIdInput.extend({ base: gitShaSchema.optional(), head: gitShaSchema.optional() }))
    .output(skillDiffSchema)
    .errors(skillErrors),
  /**
   * A Machine reports the skills on it (`scan`) and, after `agentsync skills sync`, what it did
   * (`results`). The hook sends a scan only when it changed, and at least daily.
   */
  report: machineProcedure
    .input(z.object({
      scan: z.array(scannedSkillSchema).max(1000),
      results: z.array(skillSyncResultSchema).max(1000).optional(),
    }))
    .output(z.void()),
};

export const contract = {
  health: publicProcedure.output(z.object({ ok: z.literal(true) })),
  /** The signed-in browser user, or `null`. */
  session: publicProcedure.output(userSchema.nullable()),
  template,
  machines,
  variables,
  conflicts,
  skills,
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
export type SkillName = z.infer<typeof skillNameSchema>;
export type SkillRepo = z.infer<typeof skillRepoSchema>;
export type Pin = z.infer<typeof pinSchema>;
export type AuditRisk = z.infer<typeof auditRiskSchema>;
export type Audit = z.infer<typeof auditSchema>;
export type Audits = z.infer<typeof auditsSchema>;
export type SkillUpdate = z.infer<typeof skillUpdateSchema>;
export type MachineSkillState = z.infer<typeof machineSkillStateSchema>;
export type SkillAssignment = z.infer<typeof skillAssignmentSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type FoundSkill = z.infer<typeof foundSkillSchema>;
export type SkillSettings = z.infer<typeof skillSettingsSchema>;
export type SkillsOverview = z.infer<typeof skillsOverviewSchema>;
export type PinMove = z.infer<typeof pinMoveSchema>;
export type SkillSearchResult = z.infer<typeof skillSearchResultSchema>;
export type SkillCandidate = z.infer<typeof skillCandidateSchema>;
export type SkillFileChange = z.infer<typeof skillFileChangeSchema>;
export type SkillDiff = z.infer<typeof skillDiffSchema>;
export type DesiredSkill = z.infer<typeof desiredSkillSchema>;
export type ScannedSkill = z.infer<typeof scannedSkillSchema>;
export type SkillSyncResult = z.infer<typeof skillSyncResultSchema>;
