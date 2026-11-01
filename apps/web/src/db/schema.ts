import type { AuditRisk, ScannedSkill, SkillSyncResult, Target, VariableMap } from '@agentsync/contract';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** A version of a skill folder: a commit that changed it, with its hashes (see `pinSchema`). */
export interface FolderVersion {
  commit: string;
  treeSha: string;
  installedHash: string;
  /** Milliseconds since the epoch. */
  committedAt: number;
}

/** skills.sh verdicts as JSON keeps them: dates as ISO strings. See `auditsOf` and `storedAudits`. */
export interface StoredAudits {
  gen: { risk: AuditRisk; analyzedAt: string } | null;
  socket: { risk: AuditRisk; analyzedAt: string } | null;
  snyk: { risk: AuditRisk; analyzedAt: string } | null;
}

const timestamp = (name: string) =>
  integer(name, { mode: 'timestamp_ms' }).notNull();

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  workosId: text('workos_id').unique(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at'),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', {
    mode: 'timestamp_ms',
  }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', {
    mode: 'timestamp_ms',
  }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

/** Each user's one Template: the head revision. Revision text lives in `template_revision`. */
export const template = sqliteTable('template', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  updatedAt: timestamp('updated_at'),
});

/** Immutable Template revisions, numbered from 1 per user. */
export const templateRevision = sqliteTable(
  'template_revision',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    text: text('text').notNull(),
    createdAt: timestamp('created_at'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.revision] })],
);

export const machine = sqliteTable(
  'machine',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The name a person gives the Machine. */
    nickname: text('nickname').notNull(),
    /** The computer's own hostname, reported by the CLI. */
    hostname: text('hostname').notNull(),
    os: text('os', { enum: ['macos', 'linux', 'windows'] }).notNull(),
    targets: text('targets', { mode: 'json' }).$type<Target[]>().notNull(),
    createdAt: timestamp('created_at'),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('machine_user_idx').on(table.userId)],
);

/** The hash of a Machine token. The token itself is never stored. */
export const machineCredential = sqliteTable('machine_credential', {
  tokenHash: text('token_hash').primaryKey(),
  machineId: text('machine_id')
    .notNull()
    .unique()
    .references(() => machine.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at'),
});

/** Each Machine's Variable map: the head revision. Maps live in `machine_variables_revision`. */
export const machineVariables = sqliteTable('machine_variables', {
  machineId: text('machine_id')
    .primaryKey()
    .references(() => machine.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  updatedAt: timestamp('updated_at'),
});

/** Immutable Variable map revisions, numbered from 1 per Machine. */
export const machineVariablesRevision = sqliteTable(
  'machine_variables_revision',
  {
    machineId: text('machine_id')
      .notNull()
      .references(() => machine.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    variables: text('variables', { mode: 'json' }).$type<VariableMap>().notNull(),
    createdAt: timestamp('created_at'),
  },
  (table) => [primaryKey({ columns: [table.machineId, table.revision] })],
);

export const conflict = sqliteTable(
  'conflict',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    baseRevision: integer('base_revision').notNull(),
    serverRevision: integer('server_revision').notNull(),
    text: text('text').notNull(),
    status: text('status', { enum: ['open', 'resolved', 'discarded'] }).notNull(),
    createdAt: timestamp('created_at'),
    closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('conflict_user_status_idx').on(table.userId, table.status)],
);

/**
 * A WorkOS device flow started by `machines.deviceStart` and not yet used.
 * Registering a Machine deletes the row, which makes each device code single-use.
 */
export const deviceAuthorization = sqliteTable('device_authorization', {
  deviceCodeHash: text('device_code_hash').primaryKey(),
  /** Seconds to wait between polls, raised after each WorkOS `slow_down`. */
  interval: integer('interval').notNull(),
  expiresAt: timestamp('expires_at'),
});

/**
 * A Skill in a user's account: a folder of a public GitHub repository, pinned to one commit.
 * `repo_id` is GitHub's, so a renamed repository is still the same source.
 */
export const skill = sqliteTable(
  'skill',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    repoId: integer('repo_id').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    /** Old `owner/repo` names (lowercase) that GitHub redirects here, as a Machine's `skills` lock may still record them. */
    repoAliases: text('repo_aliases', { mode: 'json' }).$type<string[]>().notNull(),
    path: text('path').notNull(),
    pinCommit: text('pin_commit').notNull(),
    pinTreeSha: text('pin_tree_sha').notNull(),
    pinInstalledHash: text('pin_installed_hash').notNull(),
    pinCommittedAt: timestamp('pin_committed_at'),
    /** `all` Machines, or the ones in `skill_machine`. */
    assignment: text('assignment', { enum: ['all', 'chosen'] }).notNull(),
    /** `false`: on the ignore list for automatic updates. */
    autoUpdate: integer('auto_update', { mode: 'boolean' }).notNull(),
    /**
     * The versions of the folder on the default branch that are newer than the Pin, newest first, as
     * the last update check found them. The first is the update candidate.
     */
    newer: text('newer', { mode: 'json' }).$type<FolderVersion[]>().notNull(),
    /** The repository's `pushed_at` when the update check first saw `newer[0]` as the newest version. */
    updatePushedAt: integer('update_pushed_at', { mode: 'timestamp_ms' }),
    /** The skills.sh verdicts, refreshed by each update check. */
    audits: text('audits', { mode: 'json' }).$type<StoredAudits>(),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
    createdAt: timestamp('created_at'),
  },
  (table) => [
    uniqueIndex('skill_user_name_idx').on(table.userId, table.name),
    index('skill_checked_idx').on(table.checkedAt),
  ],
);

/** The Machines a Skill with `assignment = 'chosen'` goes to. */
export const skillMachine = sqliteTable(
  'skill_machine',
  {
    skillId: text('skill_id')
      .notNull()
      .references(() => skill.id, { onDelete: 'cascade' }),
    machineId: text('machine_id')
      .notNull()
      .references(() => machine.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.skillId, table.machineId] }), index('skill_machine_machine_idx').on(table.machineId)],
);

/** Every move of a Skill's Pin, including the first. */
export const skillPinMove = sqliteTable(
  'skill_pin_move',
  {
    id: text('id').primaryKey(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skill.id, { onDelete: 'cascade' }),
    fromCommit: text('from_commit'),
    toCommit: text('to_commit').notNull(),
    /** The installed hash of `to_commit`, so a Machine still on an old Pin reads as pending, not drifted. */
    toInstalledHash: text('to_installed_hash').notNull(),
    kind: text('kind', { enum: ['added', 'manual', 'automatic'] }).notNull(),
    audits: text('audits', { mode: 'json' }).$type<StoredAudits>().notNull(),
    at: timestamp('at'),
  },
  (table) => [index('skill_pin_move_skill_idx').on(table.skillId, table.at)],
);

export const skillSettings = sqliteTable('skill_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  autoUpdate: integer('auto_update', { mode: 'boolean' }).notNull(),
});

/** Account-wide collection exclusions, kept even when a Machine stops reporting the skill. */
export const skillExclusion = sqliteTable('skill_exclusion', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  repo: text('repo').notNull(),
  name: text('name').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.repo, table.name] })]);

/** Each Machine's last scan and the results of its last `skills sync`. Dropped with the Machine. */
export const machineSkillReport = sqliteTable('machine_skill_report', {
  machineId: text('machine_id')
    .primaryKey()
    .references(() => machine.id, { onDelete: 'cascade' }),
  scan: text('scan', { mode: 'json' }).$type<ScannedSkill[]>().notNull(),
  /** When the Machine last reported: its last Skills check-in. */
  reportedAt: timestamp('reported_at'),
  results: text('results', { mode: 'json' }).$type<SkillSyncResult[]>(),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }),
});

/**
 * A skill folder's hashes at a commit, from GitHub. Commits are immutable, so rows never change.
 * `installed_hash` is `null` when `skills` could not install the folder faithfully (symlinks, submodules),
 * and `skill_name` says which skill, if any, the folder held then.
 */
export const skillFolderVersion = sqliteTable(
  'skill_folder_version',
  {
    repoId: integer('repo_id').notNull(),
    commit: text('commit').notNull(),
    path: text('path').notNull(),
    treeSha: text('tree_sha').notNull(),
    installedHash: text('installed_hash'),
    /** The frontmatter `name` of the folder's SKILL.md at that commit; `null` without a readable one. */
    skillName: text('skill_name'),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.commit, table.path] }), index('skill_folder_version_hash_idx').on(table.repoId, table.path, table.installedHash)],
);

export const schema = {
  user, session, account, verification,
  template, templateRevision, machine, machineCredential,
  machineVariables, machineVariablesRevision, conflict, deviceAuthorization,
  skill, skillMachine, skillPinMove, skillSettings, skillExclusion, machineSkillReport, skillFolderVersion,
};
