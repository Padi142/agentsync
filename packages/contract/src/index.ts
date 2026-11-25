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
 * Machine. Lowercase words joined by single hyphens, at most 64 characters: exactly the names the
 * `skills` CLI installs unchanged (its sanitizer would turn `a--b` or `a-` into another folder). It
 * never starts with `-`, so it can't be read as a flag either.
 */
export const skillNameSchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
/** The CLI's own skill before it was split in three. A Machine may still have it until `agentsync init` removes it. */
export const RESERVED_SKILL_NAME = 'agentsync';
/** The skills the CLI installs itself, plus the legacy one: no Skill may take these names. */
export const RESERVED_SKILL_NAMES: readonly string[] = [
  RESERVED_SKILL_NAME, 'agentsync-instructions', 'agentsync-skills', 'agentsync-spaces',
];
/** A public GitHub repository as `owner/repo`. Neither part may start with `-` or be `.`/`..`. */
export const repoNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/);
/** A full git object ID: a commit, or a tree hash. */
export const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * What `skills` 1.9.0 leaves out when it copies a skill folder, at any depth. Both the server (from GitHub's tree) and the CLI (from disk) skip
 * them when they hash a folder, so the hashes agree. Bump with the `skills` version.
 */
export const SKILL_COPY_EXCLUDES = {
  /** Entries with these names, of any kind (a directory too). */
  names: ['metadata.json'],
  /** Directories with these names. */
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

/** How far a Machine may ask: Skill Requests open at once per account, Skills one may propose, and hours until one expires. */
export const SKILL_REQUEST_LIMITS = { open: 5, skills: 20, hours: 24 } as const;

/**
 * One Skill a Skill Request proposes, pinned and audited by the server when the request was made.
 * `conflict` says why it can't be approved now: `added`, a Skill of this name from the same repository
 * is already in the account; `taken`, one from another repository has the name.
 */
export const proposedSkillSchema = z.object({
  name: skillNameSchema,
  path: z.string().max(500),
  pin: pinSchema,
  audits: auditsSchema,
  conflict: z.enum(['added', 'taken']).nullable(),
});

/**
 * A Machine's proposal to add Skills from one repository (`agentsync skills add`). Only a signed-in
 * browser approves it; `added` names the Skills approval added. `moved` is whether the repository has
 * new commits since, when the browser asked (`null`: not checked).
 */
export const skillRequestSchema = z.object({
  id,
  repo: skillRepoSchema,
  /** The default branch's head when the request was made. */
  commit: gitShaSchema,
  machine: z.object({ id, nickname: machineNicknameSchema }),
  skills: z.array(proposedSkillSchema),
  status: z.enum(['open', 'approved', 'rejected', 'expired']),
  added: z.array(skillNameSchema),
  moved: z.boolean().nullable(),
  /** The dashboard page that opens this request. */
  url: z.url(),
  createdAt: z.date(),
  expiresAt: z.date(),
});

export const skillsOverviewSchema = z.object({
  settings: skillSettingsSchema,
  skills: z.array(skillSchema),
  /** Open Skill Requests, oldest first. */
  requests: z.array(skillRequestSchema),
  found: z.array(foundSkillSchema),
  ignored: z.array(z.object({ repo: repoNameSchema, name: skillNameSchema })),
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
  /**
   * The `owner/repo` names (lowercase) a `skills` lock may record for this repository: its canonical
   * name and old ones GitHub redirects to it. Only a copy from one of these is AgentSync's to adopt.
   */
  sources: z.array(repoNameSchema).min(1).max(20),
});

/**
 * One skill folder on a Machine (in `~/.agents/skills`, any Claude Code skills directory, or Antigravity's
 * `~/.gemini/config/skills`). `source` is the `skills` lock's source, or `null` for a hand-written folder;
 * `hash` is the git tree hash on disk (`null` for hand-written folders, which report their name only, or
 * when two copies disagree). `managed`: AgentSync installed or adopted it.
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

// Spaces

/** Storage limits, enforced by the server on every upload. */
export const SPACE_LIMITS = {
  fileBytes: 500 * 1024 * 1024,
  /**
   * The most one request carries: a whole file on `PUT SPACE_WRITER_ROUTES.file`, or one part of a
   * multipart upload (`SPACE_WRITER_ROUTES.uploads`), which larger files need. Every part but the last
   * has exactly this size (R2 wants equal parts of at least 5 MiB).
   */
  partBytes: 25 * 1024 * 1024,
  spaceBytes: 1024 * 1024 * 1024,
  userBytes: 2 * 1024 * 1024 * 1024,
  /** Maximum files in one Space (keeps R2 deletion to one page and stays below ZIP's 65,535 limit). */
  maxFiles: 500,
  /** Days a new Space's Share Link works for, unless `expires` says otherwise. */
  defaultDays: 7,
  /** Days an expired Space stays in its private grace period before it is purged. */
  graceDays: 30,
  /** The longest `expires` duration, in days. Use `never` for longer. */
  maxDays: 365,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A date that also parses from an ISO string: Space schemas are read from plain JSON too
 * (`/s/<token>.json`, `/api/spaces/*`, WebSocket events), where dates arrive as strings.
 */
const wireDate = z.union([z.date(), z.iso.datetime({ offset: true }).transform((s) => new Date(s))]);

/**
 * A file's path inside a Space: relative, `/`-separated, with no empty, `.` or `..` segments,
 * no leading `/`, no backslashes or control characters (null bytes included), at most 500 characters.
 * Use `normalizeSpacePath` to turn user input into one.
 */
export const spacePathSchema = z.string().min(1).max(500).refine((path) => normalizeSpacePath(path) === path, {
  message: 'Invalid Space path.',
});

/**
 * The canonical form of a Space path, or `null` if it can't be one. Turns `\` into `/`, drops
 * a leading `./` and repeated or trailing `/`. Rejects `..`, absolute paths and control characters.
 * The server, the web viewer and the CLI (on upload, raw fetch, zip and `pull`) all call it.
 */
export function normalizeSpacePath(input: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) return null;
  const unified = input.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return null;
  const segments = unified.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..')) return null;
  const path = segments.join('/');
  return path.length <= 500 ? path : null;
}

/**
 * How long a Share Link works: `<n>d` (1–365 days from now) or `never` (permanent).
 * Setting it on an expired Space revives it at the same Share Link.
 */
export const spaceExpirySchema = z.union([
  z.literal('never'),
  z.string().regex(/^[1-9]\d{0,2}d$/).refine((v) => Number.parseInt(v, 10) <= SPACE_LIMITS.maxDays, {
    message: `At most ${SPACE_LIMITS.maxDays} days; use "never" for longer.`,
  }),
]);

/** When a Space set to `expiry` at `now` expires; `null` is permanent. */
export function spaceExpiresAt(expiry: SpaceExpiry, now: Date = new Date()): Date | null {
  return expiry === 'never' ? null : new Date(now.getTime() + Number.parseInt(expiry, 10) * DAY_MS);
}

/**
 * - `active`: the Share Link works until `expiresAt` (`null`: permanent).
 * - `expired`: `expiresAt` passed. Only the owner sees it, in the dashboard, until `deleteAt`;
 *   Write Token mutations fail with `SPACE_EXPIRED` until it is revived.
 * - `private`: the owner turned the Share Link off. It never expires or deletes by itself;
 *   the Write Token still works.
 */
export const spaceStatusSchema = z.enum(['active', 'expired', 'private']);

/** What a Space's status is at `now`. The server stores only `isPrivate` and `expiresAt`. */
export function spaceStatus(space: { isPrivate: boolean; expiresAt: Date | null }, now: Date = new Date()): SpaceStatus {
  if (space.isPrivate) return 'private';
  return space.expiresAt && space.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
}

/** When an expired Space is purged: `graceDays` after it expired. `null` unless it can expire. */
export function spaceDeleteAt(space: { isPrivate: boolean; expiresAt: Date | null }): Date | null {
  if (space.isPrivate || !space.expiresAt) return null;
  return new Date(space.expiresAt.getTime() + SPACE_LIMITS.graceDays * DAY_MS);
}

export const spaceTitleSchema = z.string().trim().min(1).max(200);
export const spaceSummarySchema = z.string().trim().max(2000);

/** One file in a Space. Only its latest version is kept. */
export const spaceFileSchema = z.object({
  path: spacePathSchema,
  size: z.number().int().min(0),
  contentType: z.string().min(1).max(255),
  /** Hex SHA-256 of the content: `space push` compares it to skip unchanged files. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  updatedAt: wireDate,
});

/** What anyone with the Share Link sees (`GET /s/<token>.json`), and what a Write Token reads (`GET /api/spaces/<id>`). */
export const publicSpaceSchema = z.object({
  id,
  title: spaceTitleSchema,
  summary: spaceSummarySchema.nullable(),
  status: spaceStatusSchema,
  expiresAt: wireDate.nullable(),
  /** `https://<origin>/s/<share-token>`. */
  shareUrl: z.url(),
  totalBytes: z.number().int().min(0),
  files: z.array(spaceFileSchema),
  createdAt: wireDate,
  updatedAt: wireDate,
});

/** A Space in the owner's dashboard. */
export const spaceSchema = publicSpaceSchema.omit({ files: true }).extend({
  /** When an expired Space is purged; `null` for active-permanent or private Spaces. */
  deleteAt: wireDate.nullable(),
  fileCount: z.number().int().min(0),
});

export const spaceDetailSchema = spaceSchema.extend({ files: z.array(spaceFileSchema) });

/** `spaces.create` answers with the Write Token once; the server keeps only its hash. */
export const createdSpaceSchema = z.object({
  space: publicSpaceSchema,
  writeToken: z.string().min(1),
});

/**
 * Messages a Space's WebSocket (`GET /s/<token>/ws`) sends, as JSON text frames:
 * - `file`: a file was added or replaced.
 * - `fileDeleted`: a file was removed.
 * - `space`: title, summary, expiry or status changed.
 * - `closed`: the Share Link stopped working (Space deleted, made private, expired, or its link rotated).
 *   The server closes the socket right after.
 */
export const spaceEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), file: spaceFileSchema }),
  z.object({ type: z.literal('fileDeleted'), path: spacePathSchema }),
  z.object({ type: z.literal('space'), space: publicSpaceSchema.omit({ files: true }) }),
  z.object({ type: z.literal('closed'), reason: z.enum(['deleted', 'private', 'expired', 'rotated']) }),
]);

/**
 * Error codes of the Spaces HTTP routes (`/s/*` and `/api/spaces/*`). They answer
 * `{ error: { code, message } }` with the status in `SPACE_ERROR_STATUS`.
 */
export const spaceErrorCodeSchema = z.enum([
  'NOT_FOUND', 'UNAUTHORIZED', 'INVALID_PATH', 'INVALID_REQUEST',
  'SPACE_EXPIRED', 'FILE_TOO_LARGE', 'SPACE_FULL', 'QUOTA_EXCEEDED',
]);
export const SPACE_ERROR_STATUS = {
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  INVALID_PATH: 422,
  INVALID_REQUEST: 400,
  SPACE_EXPIRED: 410,
  FILE_TOO_LARGE: 413,
  SPACE_FULL: 413,
  QUOTA_EXCEEDED: 413,
} as const satisfies Record<SpaceErrorCode, number>;
export const spaceErrorSchema = z.object({ error: z.object({ code: spaceErrorCodeSchema, message: z.string() }) });

/** The body of `PATCH /api/spaces/<id>`. Every field is optional. `summary: null` clears it. */
export const spaceWriterUpdateSchema = z.object({
  title: spaceTitleSchema.optional(),
  summary: spaceSummarySchema.nullable().optional(),
  expires: spaceExpirySchema.optional(),
});

/** Parts a multipart upload may have: enough for the largest file. */
export const SPACE_MAX_PARTS = Math.ceil(SPACE_LIMITS.fileBytes / SPACE_LIMITS.partBytes);

/** The body of `POST SPACE_WRITER_ROUTES.uploads`: the file a multipart upload will become. */
export const spaceUploadStartSchema = z.object({
  path: spacePathSchema,
  /** Checked against the limits now, and against the bytes actually sent on completion. */
  size: z.number().int().min(0),
  contentType: z.string().min(1).max(255).optional(),
});

/** A multipart upload in progress. `uploadId` is opaque; it works until completed, aborted, or 7 days old. */
export const spaceUploadSchema = z.object({ uploadId: z.string().min(1) });

/** One uploaded part, as `PUT SPACE_WRITER_ROUTES.uploadPart` answers and completion takes it back. */
export const spaceUploadPartSchema = z.object({
  partNumber: z.number().int().min(1).max(SPACE_MAX_PARTS),
  etag: z.string().min(1),
});

/** The body of `POST SPACE_WRITER_ROUTES.uploadComplete`. The server checks `sha256` against the joined parts. */
export const spaceUploadCompleteSchema = z.object({
  path: spacePathSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  parts: z.array(spaceUploadPartSchema).min(1).max(SPACE_MAX_PARTS),
});

/**
 * The Write Token routes. Each takes `Authorization: Bearer <write-token>`, never a Machine token or cookie.
 * Binary uploads go here rather than through oRPC so they stream as raw bodies.
 *
 * A file of at most `SPACE_LIMITS.partBytes` is one `PUT` to `file`. A larger one (up to `fileBytes`) is a
 * multipart upload: `POST uploads`, a `PUT uploadPart` for each `partBytes` slice (1-based, any order),
 * then `POST uploadComplete`, which makes it the file at `path`. `DELETE upload` drops an unfinished one.
 */
export const SPACE_WRITER_ROUTES = {
  /** `GET` → `publicSpaceSchema` (works while expired, so a writer can see why it fails). `PATCH` with `spaceWriterUpdateSchema` → `publicSpaceSchema`. `DELETE` → 204. */
  space: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}`,
  /**
   * `PUT` raw bytes with `Content-Type` (and optionally `X-Content-SHA256`, verified) → `spaceFileSchema`.
   * `DELETE` → 204. `path` must already be normalized; each segment is URI-encoded.
   */
  file: (spaceId: string, path: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/files/${path.split('/').map(encodeURIComponent).join('/')}`,
  /** `POST` with `spaceUploadStartSchema` → `spaceUploadSchema`. Fails now if the file can't fit. */
  uploads: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/uploads`,
  /** `DELETE` → 204: abort the upload, also when it is already gone. */
  upload: (spaceId: string, uploadId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/uploads/${encodeURIComponent(uploadId)}`,
  /** `PUT` one part's raw bytes, with `Content-Length` → `spaceUploadPartSchema`. Sending a part again replaces it. */
  uploadPart: (spaceId: string, uploadId: string, partNumber: number) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
  /** `POST` with `spaceUploadCompleteSchema` → `spaceFileSchema`. */
  uploadComplete: (spaceId: string, uploadId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/uploads/${encodeURIComponent(uploadId)}/complete`,
} as const;

/** The public routes of a Share Link, relative to the app origin. Anyone with the link may call them. */
export const SPACE_PUBLIC_ROUTES = {
  /** `Accept: text/html` → the web viewer; `text/markdown` → digest; `application/json` → `publicSpaceSchema`. */
  space: (shareToken: string) => `/s/${shareToken}`,
  markdown: (shareToken: string) => `/s/${shareToken}.md`,
  json: (shareToken: string) => `/s/${shareToken}.json`,
  raw: (shareToken: string, path: string) => `/s/${shareToken}/raw/${path.split('/').map(encodeURIComponent).join('/')}`,
  zip: (shareToken: string) => `/s/${shareToken}/download.zip`,
  ws: (shareToken: string) => `/s/${shareToken}/ws`,
} as const;

/**
 * Session-authenticated owner routes for reading files of any owned Space (active, private or expired).
 * They read only the browser session cookie, never a Machine token or Write Token.
 */
export const SPACE_OWNER_ROUTES = {
  raw: (spaceId: string, path: string) =>
    `/api/owner/spaces/${encodeURIComponent(spaceId)}/raw/${path.split('/').map(encodeURIComponent).join('/')}`,
  zip: (spaceId: string) => `/api/owner/spaces/${encodeURIComponent(spaceId)}/download.zip`,
} as const;

/** A Share Link token: 32 base64url characters. */
export const shareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

/** The Share Link token in a Share Link URL (`https://<host>/s/<token>`, with or without a suffix), or `null`. */
export function parseShareUrl(url: string): { origin: string; shareToken: string } | null {
  // The contract has no DOM or Node types, so no `URL` here.
  const match = url.trim().match(/^(https?:\/\/[^/?#\s]+)\/s\/([A-Za-z0-9_-]{32})(?:\.md|\.json)?(?:[/?#].*)?$/i);
  return match?.[1] && match[2] ? { origin: match[1].toLowerCase(), shareToken: match[2] } : null;
}

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

/** How many skills one `skills.addMany` call takes, so each call stays within a Worker's request budget. */
export const ADD_BATCH_SIZE = 6;

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

const skillRequestErrors = {
  ...skillErrors,
  /** Some names asked for aren't skills of the repository. `available` is every skill it has. */
  UNKNOWN_SKILLS: { status: 404, data: z.object({ unknown: z.array(skillNameSchema), available: z.array(skillNameSchema) }) },
  /** The account already has `SKILL_REQUEST_LIMITS.open` open Skill Requests. */
  REQUEST_LIMIT: { status: 429 },
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
const requestIdInput = z.object({ requestId: id });

/**
 * Skills are changed only from a signed-in browser. A Machine reads its own list (in `machines.sync`),
 * reports, and may propose Skills as a Skill Request, which only the browser approves.
 */
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
  /** Browse a repository at one commit, in pages that fit the Worker's request budget. */
  collection: sessionProcedure
    .input(z.object({ repo: repoNameSchema, offset: z.number().int().min(0).default(0), commit: gitShaSchema.optional() }))
    .output(z.object({ repo: repoNameSchema, commit: gitShaSchema, names: z.array(skillNameSchema), next: z.number().int().nullable() }))
    .errors(skillErrors),
  /** The latest skills.sh verdicts for skills of one repository, without adding them. */
  audits: sessionProcedure
    .input(z.object({ repo: repoNameSchema, names: z.array(skillNameSchema).min(1).max(100) }))
    .output(z.array(z.object({ name: skillNameSchema, audits: auditsSchema })))
    .errors(skillErrors),
  /** Hide Found Skills from the not-synced list, or restore them. Skills already synced are unaffected. */
  setIgnored: sessionProcedure
    .input(z.object({ repo: repoNameSchema, names: z.array(skillNameSchema).min(1).max(500), ignored: z.boolean() }))
    .output(z.void()),
  /**
   * Add a Skill, assigned to every Machine. With `machineId` (a Found Skill), pin the commit that
   * Machine already has, so nothing is reinstalled; otherwise the newest on the default branch.
   */
  add: sessionProcedure
    .input(z.object({ repo: repoNameSchema, name: skillNameSchema, machineId: id.optional() }))
    .output(skillSchema)
    .errors(skillErrors),
  /**
   * Add several skills of one repository, as `add` does, reading the repository only once. One skill's
   * failure doesn't stop the others. `rest` holds the skills not tried yet, because the call ran out of
   * budget or GitHub stopped answering (then the last of `failed` says UPSTREAM_UNAVAILABLE).
   */
  addMany: sessionProcedure
    .input(z.object({
      repo: repoNameSchema,
      skills: z.array(z.object({ name: skillNameSchema, machineId: id.optional() })).min(1).max(ADD_BATCH_SIZE),
    }))
    .output(z.object({
      added: z.array(skillNameSchema),
      failed: z.array(z.object({
        name: skillNameSchema,
        code: z.enum(['NOT_FOUND', 'UNSUPPORTED_SKILL', 'SKILL_NAME_TAKEN', 'NO_MATCHING_COMMIT', 'UPSTREAM_UNAVAILABLE']),
        reason: z.string().optional(),
      })),
      rest: z.array(skillNameSchema),
    }))
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
   * (`results`). The hook sends a scan only when it changed, and at least daily. `partial`: the results
   * cover only some Skills (`skills add` installing what it just got approved), so they replace only those.
   */
  report: machineProcedure
    .input(z.object({
      scan: z.array(scannedSkillSchema).max(1000),
      results: z.array(skillSyncResultSchema).max(1000).optional(),
      partial: z.boolean().optional(),
    }))
    .output(z.void()),
  /**
   * Propose Skills of a repository for the browser to approve: `names`, or every skill it has. The server
   * pins and audits them now. An open request from the same Machine for the same repository and names is
   * resumed instead (`resumed`); one with other names is replaced. `reading` means the repository is too
   * large to read in one call: call again, and it carries on from what it read.
   */
  request: machineProcedure
    .input(z.object({ repo: repoNameSchema, names: z.array(skillNameSchema).min(1).max(SKILL_REQUEST_LIMITS.skills).optional() }))
    .output(z.discriminatedUnion('status', [
      z.object({ status: z.literal('reading') }),
      z.object({ status: z.literal('ready'), request: skillRequestSchema, resumed: z.boolean() }),
    ]))
    .errors(skillRequestErrors),
  /** A Skill Request: any of the account's for a browser, only its own for a Machine. A browser also learns whether the repository `moved`. */
  getRequest: anyAuthProcedure.input(requestIdInput).output(skillRequestSchema).errors(notFoundError),
  /**
   * Approve an open Skill Request: add the Skills `names`, at exactly the Pins it shows, with this
   * assignment. A name that is `conflict`ed can't be approved.
   */
  approveRequest: sessionProcedure
    .input(requestIdInput.extend({ names: z.array(skillNameSchema).min(1).max(SKILL_REQUEST_LIMITS.skills), assignment: skillAssignmentSchema }))
    .output(skillRequestSchema)
    .errors({ ...notFoundError, SKILL_NAME_TAKEN: skillErrors.SKILL_NAME_TAKEN }),
  rejectRequest: sessionProcedure.input(requestIdInput).output(skillRequestSchema).errors(notFoundError),
};

const spaceIdInput = z.object({ spaceId: id });

/**
 * A Machine creates a Space; everything else a signed-in browser does from `/spaces`. Writing files
 * needs the Write Token on `SPACE_WRITER_ROUTES`, so a Machine token can't list or touch existing Spaces.
 */
const spaces = {
  /** Create an empty Space owned by the Machine's user. Returns the Write Token once. */
  create: machineProcedure
    .input(z.object({
      title: spaceTitleSchema,
      summary: spaceSummarySchema.optional(),
      /** Default: `7d`. */
      expires: spaceExpirySchema.optional(),
    }))
    .output(createdSpaceSchema)
    .errors({ QUOTA_EXCEEDED: { status: 413 } }),
  /** Every Space of the user, active, private and expired, newest first, with the account's storage use. */
  list: sessionProcedure.output(z.object({
    spaces: z.array(spaceSchema),
    usedBytes: z.number().int().min(0),
    limitBytes: z.number().int().positive(),
  })),
  get: sessionProcedure.input(spaceIdInput).output(spaceDetailSchema).errors(notFoundError),
  /**
   * Rename, extend, make permanent (`expires: 'never'`), revive an expired Space (any `expires`; same Share Link),
   * or turn the Share Link off (`private: true`). Turning it back on gives an expired Space a fresh default expiry.
   */
  update: sessionProcedure
    .input(spaceIdInput.extend({
      title: spaceTitleSchema.optional(),
      summary: spaceSummarySchema.nullable().optional(),
      expires: spaceExpirySchema.optional(),
      private: z.boolean().optional(),
    }))
    .output(spaceSchema)
    .errors(notFoundError),
  /** Replace the Share Link with a new one. The old link stops working at once; the Write Token is unchanged. */
  rotateLink: sessionProcedure.input(spaceIdInput).output(spaceSchema).errors(notFoundError),
  /** Delete the Space and all its files now. */
  delete: sessionProcedure.input(spaceIdInput).output(z.void()).errors(notFoundError),
  deleteFile: sessionProcedure
    .input(spaceIdInput.extend({ path: spacePathSchema }))
    .output(spaceDetailSchema)
    .errors(notFoundError),
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
  spaces,
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
export type ProposedSkill = z.infer<typeof proposedSkillSchema>;
export type SkillRequest = z.infer<typeof skillRequestSchema>;
export type PinMove = z.infer<typeof pinMoveSchema>;
export type SkillSearchResult = z.infer<typeof skillSearchResultSchema>;
export type SkillCandidate = z.infer<typeof skillCandidateSchema>;
export type SkillFileChange = z.infer<typeof skillFileChangeSchema>;
export type SkillDiff = z.infer<typeof skillDiffSchema>;
export type DesiredSkill = z.infer<typeof desiredSkillSchema>;
export type ScannedSkill = z.infer<typeof scannedSkillSchema>;
export type SkillSyncResult = z.infer<typeof skillSyncResultSchema>;
export type SpaceExpiry = z.infer<typeof spaceExpirySchema>;
export type SpaceStatus = z.infer<typeof spaceStatusSchema>;
export type SpaceFile = z.infer<typeof spaceFileSchema>;
export type PublicSpace = z.infer<typeof publicSpaceSchema>;
export type Space = z.infer<typeof spaceSchema>;
export type SpaceDetail = z.infer<typeof spaceDetailSchema>;
export type CreatedSpace = z.infer<typeof createdSpaceSchema>;
export type SpaceEvent = z.infer<typeof spaceEventSchema>;
export type SpaceErrorCode = z.infer<typeof spaceErrorCodeSchema>;
export type SpaceWriterUpdate = z.infer<typeof spaceWriterUpdateSchema>;
export type SpaceUploadStart = z.infer<typeof spaceUploadStartSchema>;
export type SpaceUploadPart = z.infer<typeof spaceUploadPartSchema>;
export type SpaceUploadComplete = z.infer<typeof spaceUploadCompleteSchema>;
