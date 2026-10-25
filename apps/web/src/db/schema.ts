import type { Target, VariableMap } from '@agentsync/contract';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

export const schema = {
  user, session, account, verification,
  template, templateRevision, machine, machineCredential,
  machineVariables, machineVariablesRevision, conflict, deviceAuthorization,
};
