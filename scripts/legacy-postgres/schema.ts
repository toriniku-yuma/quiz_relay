// Existing database introspected with Drizzle Kit; preserve constraint names.

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Restriction, Sanction, SanctionKind } from '../../src/shared/moderation';
import type { InstancePermission } from '../../src/shared/organization';
import type {
  QuestionInput,
  QuestionSelection,
  QuestionSettings,
  SubmissionStatus,
} from '../../src/shared/questions';
import {
  type BroughtQuestion,
  type CasualSettings,
  defaultCasualSettings,
} from '../../src/shared/rooms.ts';
import type { FixedQuestion } from '../../src/worker/catalog/definition.ts';
import type { Rules } from '../../src/worker/game/rules.ts';
import type { ResultRecord } from '../../src/worker/results/record';

export const quizGame = pgSchema('quiz_game');
export const quizProbe = pgSchema('quiz_probe');

export const catalogOperators = quizGame
  .table(
    'catalog_operators',
    {
      roleName: text('role_name').primaryKey(),
      owner: text().notNull(),
    },
    (table) => [
      pgPolicy('catalog_identity', {
        for: 'select',
        to: ['quiz_game_catalog'],
        using: sql`${table.roleName} = current_user`,
      }),
    ],
  )
  .enableRLS();

function catalogPolicies(owner: AnyPgColumn, mutable = false) {
  const access = sql`${owner} IN (SELECT owner FROM quiz_game.catalog_operators WHERE role_name = current_user)`;
  const organizationOwner = sql`${owner} IN (SELECT owner FROM quiz_game.instances WHERE organization_id::text = current_setting('quiz.organization_id', true))`;
  return [
    pgPolicy('organization_catalog_read', {
      for: 'select',
      to: ['quiz_organization'],
      using: organizationOwner,
    }),
    pgPolicy('organization_catalog_insert', {
      for: 'insert',
      to: ['quiz_organization'],
      withCheck: organizationOwner,
    }),
    ...(mutable
      ? [
          pgPolicy('organization_catalog_update', {
            for: 'update',
            to: ['quiz_organization'],
            using: organizationOwner,
            withCheck: organizationOwner,
          }),
        ]
      : []),
    pgPolicy('catalog_read', { for: 'select', to: ['quiz_game_catalog'], using: access }),
    pgPolicy('catalog_insert', {
      for: 'insert',
      to: ['quiz_game_catalog'],
      withCheck: access,
    }),
    ...(mutable
      ? [
          pgPolicy('catalog_update', {
            for: 'update',
            to: ['quiz_game_catalog'],
            using: access,
            withCheck: access,
          }),
        ]
      : []),
  ];
}

export const probeRuns = quizProbe
  .table(
    'runs',
    {
      id: uuid().primaryKey().notNull(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .defaultNow()
        .notNull(),
    },
    () => [
      pgPolicy('probe_access', {
        as: 'permissive',
        for: 'all',
        to: ['quiz_probe'],
        using: sql`true`,
        withCheck: sql`true`,
      }),
    ],
  )
  .enableRLS();

export const questionAvailability = quizGame
  .table(
    'question_availability',
    {
      owner: text().notNull(),
      questionId: text('question_id').notNull(),
      retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),
    },
    (table) => [
      ...catalogPolicies(table.owner, true),
      primaryKey({
        columns: [table.owner, table.questionId],
        name: 'question_availability_pkey',
      }),
      pgPolicy('reader', {
        as: 'permissive',
        for: 'select',
        to: ['quiz_game_reader'],
        using: sql`true`,
      }),
      pgPolicy('config_read', {
        for: 'select',
        to: ['quiz_game_config'],
        using: sql`true`,
      }),
      check(
        'question_availability_owner_check',
        sql`(length(owner) >= 1) AND (length(owner) <= 256)`,
      ),
      check(
        'question_availability_question_id_check',
        sql`question_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text`,
      ),
    ],
  )
  .enableRLS();

export const questionSets = quizGame
  .table(
    'question_sets',
    {
      owner: text().notNull(),
      setId: text('set_id').notNull(),
      version: integer().notNull(),
      manifestHash: text('manifest_hash').notNull(),
      selection: jsonb().$type<QuestionSelection>(),
    },
    (table) => [
      ...catalogPolicies(table.owner),
      primaryKey({
        columns: [table.owner, table.setId, table.version],
        name: 'question_sets_pkey',
      }),
      pgPolicy('reader', {
        as: 'permissive',
        for: 'select',
        to: ['quiz_game_reader'],
        using: sql`true`,
      }),
      pgPolicy('config_read', {
        for: 'select',
        to: ['quiz_game_config'],
        using: sql`true`,
      }),
      check(
        'question_sets_manifest_hash_check',
        sql`manifest_hash ~ '^[0-9a-f]{64}$'::text`,
      ),
      check(
        'question_sets_owner_check',
        sql`(length(owner) >= 1) AND (length(owner) <= 256)`,
      ),
      check('question_sets_set_id_check', sql`set_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text`),
      check('question_sets_version_check', sql`version > 0`),
    ],
  )
  .enableRLS();

export const questionVersions = quizGame
  .table(
    'question_versions',
    {
      owner: text().notNull(),
      questionId: text('question_id').notNull(),
      version: integer().notNull(),
      payload: jsonb().$type<FixedQuestion>().notNull(),
    },
    (table) => [
      ...catalogPolicies(table.owner),
      primaryKey({
        columns: [table.owner, table.questionId, table.version],
        name: 'question_versions_pkey',
      }),
      pgPolicy('reader', {
        as: 'permissive',
        for: 'select',
        to: ['quiz_game_reader'],
        using: sql`true`,
      }),
      pgPolicy('config_read', {
        for: 'select',
        to: ['quiz_game_config'],
        using: sql`true`,
      }),
      check(
        'question_versions_check',
        sql`(jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 16384) AND ((payload ->> 'id'::text) = question_id) AND (((payload ->> 'version'::text))::integer = version) AND (payload ? 'id'::text) AND (payload ? 'version'::text)`,
      ),
      check(
        'question_versions_owner_check',
        sql`(length(owner) >= 1) AND (length(owner) <= 256)`,
      ),
      check(
        'question_versions_question_id_check',
        sql`question_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text`,
      ),
      check('question_versions_version_check', sql`version = 1`),
    ],
  )
  .enableRLS();

export const matchmakingSettings = quizGame
  .table(
    'matchmaking_settings',
    {
      owner: text().notNull(),
      profile: text().notNull(),
      competitionId: text('competition_id').notNull(),
      competitionVersion: integer('competition_version').notNull(),
    },
    (table) => [
      ...catalogPolicies(table.owner, true),
      foreignKey({
        columns: [table.owner, table.competitionId, table.competitionVersion],
        foreignColumns: [
          competitions.owner,
          competitions.competitionId,
          competitions.version,
        ],
        name: 'matchmaking_settings_owner_competition_id_competition_vers_fkey',
      }),
      primaryKey({
        columns: [table.owner, table.profile],
        name: 'matchmaking_settings_pkey',
      }),
      pgPolicy('reader', {
        as: 'permissive',
        for: 'select',
        to: ['quiz_game_reader'],
        using: sql`true`,
      }),
      pgPolicy('config_read', {
        for: 'select',
        to: ['quiz_game_config'],
        using: sql`true`,
      }),
      pgPolicy('config_insert', {
        for: 'insert',
        to: ['quiz_game_config'],
        withCheck: sql`true`,
      }),
      pgPolicy('config_update', {
        for: 'update',
        to: ['quiz_game_config'],
        using: sql`true`,
        withCheck: sql`true`,
      }),
      check(
        'matchmaking_settings_profile_check',
        sql`profile ~ '^[a-zA-Z0-9_-]{1,64}$'::text`,
      ),
    ],
  )
  .enableRLS();

export const rulesetVersions = quizGame
  .table(
    'ruleset_versions',
    {
      owner: text().notNull(),
      rulesetId: text('ruleset_id').notNull(),
      version: integer().notNull(),
      rulesHash: text('rules_hash').notNull(),
      config: jsonb().$type<Rules>().notNull(),
    },
    (table) => [
      ...catalogPolicies(table.owner),
      primaryKey({
        columns: [table.owner, table.rulesetId, table.version],
        name: 'ruleset_versions_pkey',
      }),
      pgPolicy('reader', {
        as: 'permissive',
        for: 'select',
        to: ['quiz_game_reader'],
        using: sql`true`,
      }),
      pgPolicy('config_read', {
        for: 'select',
        to: ['quiz_game_config'],
        using: sql`true`,
      }),
      pgPolicy('config_insert', {
        for: 'insert',
        to: ['quiz_game_config'],
        withCheck: sql`true`,
      }),
      check(
        'ruleset_versions_config_check',
        sql`(jsonb_typeof(config) = 'object'::text) AND (octet_length((config)::text) <= 4096)`,
      ),
      check(
        'ruleset_versions_owner_check',
        sql`(length(owner) >= 1) AND (length(owner) <= 256)`,
      ),
      check(
        'ruleset_versions_rules_hash_check',
        sql`rules_hash ~ '^[0-9a-f]{64}$'::text`,
      ),
      check(
        'ruleset_versions_ruleset_id_check',
        sql`ruleset_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text`,
      ),
      check('ruleset_versions_version_check', sql`version > 0`),
    ],
  )
  .enableRLS();

export const questionSetItems = quizGame
  .table(
    'question_set_items',
    {
      owner: text().notNull(),
      setId: text('set_id').notNull(),
      setVersion: integer('set_version').notNull(),
      ordinal: integer().notNull(),
      questionId: text('question_id').notNull(),
      questionVersion: integer('question_version').notNull(),
    },
    (table) => [
      ...catalogPolicies(table.owner),
      foreignKey({
        columns: [table.owner, table.questionId, table.questionVersion],
        foreignColumns: [
          questionVersions.owner,
          questionVersions.questionId,
          questionVersions.version,
        ],
        name: 'question_set_items_owner_question_id_question_version_fkey',
      }),
      foreignKey({
        columns: [table.owner, table.setId, table.setVersion],
        foreignColumns: [questionSets.owner, questionSets.setId, questionSets.version],
        name: 'question_set_items_owner_set_id_set_version_fkey',
      }),
      primaryKey({
        columns: [table.owner, table.setId, table.setVersion, table.ordinal],
        name: 'question_set_items_pkey',
      }),
      unique('question_set_items_owner_set_id_set_version_question_id_key').on(
        table.owner,
        table.setId,
        table.setVersion,
        table.questionId,
      ),
      pgPolicy('reader', {
        as: 'permissive',
        for: 'select',
        to: ['quiz_game_reader'],
        using: sql`true`,
      }),
      pgPolicy('config_read', {
        for: 'select',
        to: ['quiz_game_config'],
        using: sql`true`,
      }),
      check('question_set_items_ordinal_check', sql`(ordinal >= 1) AND (ordinal <= 100)`),
    ],
  )
  .enableRLS();

export const competitions = quizGame
  .table(
    'competitions',
    {
      owner: text().notNull(),
      competitionId: text('competition_id').notNull(),
      version: integer().notNull(),
      playersPerMatch: integer('players_per_match').notNull(),
      rulesetId: text('ruleset_id').notNull(),
      rulesetVersion: integer('ruleset_version').notNull(),
      setId: text('set_id').notNull(),
      setVersion: integer('set_version').notNull(),
    },
    (table) => [
      ...catalogPolicies(table.owner),
      foreignKey({
        columns: [table.owner, table.rulesetId, table.rulesetVersion],
        foreignColumns: [
          rulesetVersions.owner,
          rulesetVersions.rulesetId,
          rulesetVersions.version,
        ],
        name: 'competitions_owner_ruleset_id_ruleset_version_fkey',
      }),
      foreignKey({
        columns: [table.owner, table.setId, table.setVersion],
        foreignColumns: [questionSets.owner, questionSets.setId, questionSets.version],
        name: 'competitions_owner_set_id_set_version_fkey',
      }),
      primaryKey({
        columns: [table.owner, table.competitionId, table.version],
        name: 'competitions_pkey',
      }),
      pgPolicy('reader', {
        as: 'permissive',
        for: 'select',
        to: ['quiz_game_reader'],
        using: sql`true`,
      }),
      pgPolicy('config_read', {
        for: 'select',
        to: ['quiz_game_config'],
        using: sql`true`,
      }),
      pgPolicy('config_insert', {
        for: 'insert',
        to: ['quiz_game_config'],
        withCheck: sql`true`,
      }),
      check(
        'competitions_competition_id_check',
        sql`competition_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text`,
      ),
      check(
        'competitions_players_per_match_check',
        sql`(players_per_match >= 2) AND (players_per_match <= 4)`,
      ),
      check('competitions_version_check', sql`version > 0`),
    ],
  )
  .enableRLS();

export const matchResults = quizGame
  .table(
    'match_results',
    {
      resultId: uuid('result_id').primaryKey(),
      owner: text().notNull(),
      matchId: uuid('match_id').notNull(),
      finishedAt: timestamp('finished_at', {
        withTimezone: true,
        mode: 'string',
      }).notNull(),
      payloadHash: text('payload_hash').notNull(),
      payload: jsonb().$type<ResultRecord>().notNull(),
    },
    (table) => [
      unique().on(table.owner, table.matchId),
      index().on(table.owner, table.finishedAt),
      check('match_results_hash', sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
      pgPolicy('reader', { for: 'select', to: ['quiz_game_reader'], using: sql`true` }),
      pgPolicy('result_read', {
        for: 'select',
        to: ['quiz_game_results'],
        using: sql`true`,
      }),
      pgPolicy('result_insert', {
        for: 'insert',
        to: ['quiz_game_results'],
        withCheck: sql`true`,
      }),
    ],
  )
  .enableRLS();

export const resultPlayers = quizGame
  .table(
    'result_players',
    {
      resultId: uuid('result_id')
        .notNull()
        .references(() => matchResults.resultId),
      actorId: text('actor_id').notNull(),
      name: text().notNull(),
      ratingDelta: integer('rating_delta').notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.resultId, table.actorId] }),
      index().on(table.actorId),
      check('result_players_delta', sql`${table.ratingDelta} IN (-20, 0, 20)`),
      pgPolicy('reader', { for: 'select', to: ['quiz_game_reader'], using: sql`true` }),
      pgPolicy('result_read', {
        for: 'select',
        to: ['quiz_game_results'],
        using: sql`true`,
      }),
      pgPolicy('result_insert', {
        for: 'insert',
        to: ['quiz_game_results'],
        withCheck: sql`true`,
      }),
    ],
  )
  .enableRLS();

// 外部宛先・署名・配送状態は2Cで追加。1Dではローカル原本を同一TXで保持する。
export const resultOutbox = quizGame
  .table(
    'result_outbox',
    {
      resultId: uuid('result_id')
        .primaryKey()
        .references(() => matchResults.resultId),
      payloadHash: text('payload_hash').notNull(),
      payload: jsonb().$type<ResultRecord>().notNull(),
    },
    () => [
      pgPolicy('result_read', {
        for: 'select',
        to: ['quiz_game_results'],
        using: sql`true`,
      }),
      pgPolicy('result_insert', {
        for: 'insert',
        to: ['quiz_game_results'],
        withCheck: sql`true`,
      }),
    ],
  )
  .enableRLS();

const organizationAccess = () =>
  pgPolicy('organization_service', {
    for: 'all',
    to: ['quiz_organization'],
    using: sql`true`,
    withCheck: sql`true`,
  });
export const moderationSanctions = quizGame
  .table(
    'moderation_sanctions',
    {
      id: uuid().primaryKey(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      instanceId: uuid('instance_id').references(() => instances.id),
      actorId: text('actor_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      kind: text().$type<SanctionKind>().notNull(),
      restrictions: jsonb().$type<Restriction[]>().notNull(),
      reason: text().notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
      revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
      revision: integer().notNull().default(1),
    },
    (table) => [
      organizationAccess(),
      index().on(table.actorId, table.instanceId),
      check('sanction_kind', sql`${table.kind} IN ('timeout','ban','partial')`),
      check(
        'sanction_scope',
        sql`${table.instanceId} IS NOT NULL OR ${table.kind} = 'ban'`,
      ),
      check(
        'sanction_expiry',
        sql`(${table.kind} = 'timeout') = (${table.expiresAt} IS NOT NULL)`,
      ),
      check('sanction_revision', sql`${table.revision} > 0`),
    ],
  )
  .enableRLS();
export const moderationEvents = quizGame
  .table(
    'moderation_events',
    {
      id: uuid().primaryKey(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      instanceId: uuid('instance_id').references(() => instances.id),
      actorId: text('actor_id').notNull(),
      operatorId: text('operator_id').notNull(),
      action: text().$type<'add' | 'change' | 'revoke' | 'inspect'>().notNull(),
      reason: text().notNull(),
      requestHash: text('request_hash').notNull(),
      before: jsonb().$type<Sanction>(),
      after: jsonb().$type<Sanction>(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
      readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
    },
    (table) => [
      organizationAccess(),
      index().on(table.actorId, table.createdAt),
      check(
        'moderation_action',
        sql`${table.action} IN ('add','change','revoke','inspect')`,
      ),
    ],
  )
  .enableRLS();
export const organizations = quizGame
  .table(
    'organizations',
    {
      id: uuid().primaryKey(),
      singleton: boolean().notNull().default(true).unique(),
      name: text().notNull(),
      identityNamespace: text('identity_namespace').notNull().unique(),
    },
    (table) => [
      check('one_organization', sql`${table.singleton} = true`),
      check(
        'organization_name_length',
        sql`char_length(btrim(${table.name})) BETWEEN 1 AND 80`,
      ),
      check(
        'organization_namespace_length',
        sql`char_length(btrim(${table.identityNamespace})) BETWEEN 1 AND 256`,
      ),
      organizationAccess(),
    ],
  )
  .enableRLS();
export const organizationAccounts = quizGame
  .table(
    'organization_accounts',
    {
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      subject: text().notNull(),
      actorId: text('actor_id').primaryKey(),
      administrator: boolean().notNull().default(false),
      displayName: text('display_name'),
      profileRevision: integer('profile_revision').notNull().default(0),
      withdrawnAt: timestamp('withdrawn_at', { withTimezone: true, mode: 'string' }),
    },
    (table) => [
      unique().on(table.organizationId, table.subject),
      unique('organization_display_name_unique').on(
        table.organizationId,
        table.displayName,
      ),
      check('profile_revision_valid', sql`${table.profileRevision} >= 0`),
      check(
        'account_subject_length',
        sql`char_length(btrim(${table.subject})) BETWEEN 1 AND 256`,
      ),
      check('account_actor_hash', sql`${table.actorId} ~ '^[0-9a-f]{64}$'`),
      organizationAccess(),
    ],
  )
  .enableRLS();
export const accountWithdrawals = quizGame
  .table(
    'account_withdrawals',
    {
      id: uuid().primaryKey(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      actorId: text('actor_id')
        .notNull()
        .unique()
        .references(() => organizationAccounts.actorId),
      requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
      authDeletedAt: timestamp('auth_deleted_at', { withTimezone: true, mode: 'string' }),
      erasedAt: timestamp('erased_at', { withTimezone: true, mode: 'string' }),
      retryAt: timestamp('retry_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
      attempts: integer().notNull().default(0),
      roomCursor: text('room_cursor'),
      lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .default(sql`'epoch'::timestamptz`),
    },
    () => [organizationAccess()],
  )
  .enableRLS();

export const instances = quizGame
  .table(
    'instances',
    {
      id: uuid().primaryKey(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      owner: text().notNull().unique(),
      name: text().notNull(),
      state: text()
        .$type<'preparing' | 'published' | 'archived'>()
        .notNull()
        .default('preparing'),
      operationRevision: integer('operation_revision').notNull().default(0),
      pauseReason: text('pause_reason'),
      rankedPauseReason: text('ranked_pause_reason'),
      casualPauseReason: text('casual_pause_reason'),
      casualConfig: jsonb('casual_config')
        .$type<CasualSettings>()
        .notNull()
        .default(defaultCasualSettings),
      roomInventoryComplete: boolean('room_inventory_complete').notNull().default(false),
    },
    (table) => [
      check(
        'instance_name_length',
        sql`char_length(btrim(${table.name})) BETWEEN 1 AND 80`,
      ),
      check(
        'instance_owner_length',
        sql`char_length(btrim(${table.owner})) BETWEEN 1 AND 256`,
      ),
      index().on(table.organizationId),
      check(
        'instance_state',
        sql`${table.state} IN ('preparing', 'published', 'archived')`,
      ),
      organizationAccess(),
    ],
  )
  .enableRLS();
export const accountInstanceSelections = quizGame
  .table(
    'account_instance_selections',
    {
      actorId: text('actor_id')
        .notNull()
        .references(() => organizationAccounts.actorId, { onDelete: 'cascade' }),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id, { onDelete: 'cascade' }),
    },
    (table) => [
      primaryKey({ columns: [table.actorId, table.instanceId] }),
      index().on(table.instanceId),
      organizationAccess(),
    ],
  )
  .enableRLS();

export const instanceRooms = quizGame
  .table(
    'instance_rooms',
    {
      roomId: text('room_id').primaryKey(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      reviewAttemptedAt: timestamp('review_attempted_at', {
        withTimezone: true,
        mode: 'string',
      })
        .notNull()
        .default(sql`'epoch'::timestamptz`),
    },
    (table) => [index().on(table.reviewAttemptedAt, table.roomId), organizationAccess()],
  )
  .enableRLS();

export const instanceDeletions = quizGame
  .table(
    'instance_deletions',
    {
      id: uuid().primaryKey(),
      instanceId: uuid('instance_id').notNull().unique(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      owner: text().notNull(),
      name: text().notNull(),
      operatorId: text('operator_id').notNull(),
      requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
      deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
      acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'string' }),
      checkCursor: text('check_cursor'),
      roomCursor: text('room_cursor'),
      inventoryPending: boolean('inventory_pending').notNull().default(false),
      lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .default(sql`'epoch'::timestamptz`),
    },
    () => [organizationAccess()],
  )
  .enableRLS();

export const roomInventoryScans = quizGame
  .table('room_inventory_scans', {
    id: text().primaryKey(),
    scopeIds: jsonb('scope_ids').$type<string[]>().notNull(),
    cursor: text(),
    complete: boolean().notNull().default(false),
    localHash: text('local_hash'),
  })
  .enableRLS();

export const instanceGrants = quizGame
  .table(
    'instance_grants',
    {
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      actorId: text('actor_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      permission: text().$type<InstancePermission>().notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.instanceId, table.actorId, table.permission] }),
      index().on(table.actorId),
      check(
        'instance_permission',
        sql`${table.permission} IN ('questions', 'authors', 'users')`,
      ),
      organizationAccess(),
    ],
  )
  .enableRLS();

// Separate from account/instance FKs so future retirement cannot erase an audit trail.
export const organizationEvents = quizGame
  .table(
    'organization_events',
    {
      id: uuid().primaryKey(),
      actorId: text('actor_id').notNull(),
      instanceId: uuid('instance_id'),
      action: text().$type<'setup' | 'add' | 'publish' | 'rename' | 'grants'>().notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' })
        .defaultNow()
        .notNull(),
      details: jsonb().$type<Record<string, unknown>>().notNull(),
    },
    (table) => [
      check('organization_event_actor_hash', sql`${table.actorId} ~ '^[0-9a-f]{64}$'`),
      check(
        'organization_event_action',
        sql`${table.action} IN ('setup', 'add', 'publish', 'rename', 'grants')`,
      ),
      index().on(table.occurredAt),
      organizationAccess(),
    ],
  )
  .enableRLS();

const questionOrganizationAccess = () =>
  pgPolicy('organization_service', {
    for: 'all',
    to: ['quiz_organization'],
    using: sql`instance_id IN (SELECT id FROM quiz_game.instances WHERE organization_id::text = current_setting('quiz.organization_id', true))`,
    withCheck: sql`instance_id IN (SELECT id FROM quiz_game.instances WHERE organization_id::text = current_setting('quiz.organization_id', true))`,
  });

export const questionSettings = quizGame
  .table(
    'question_settings',
    {
      instanceId: uuid('instance_id')
        .primaryKey()
        .references(() => instances.id),
      revision: integer().notNull().default(1),
      config: jsonb().$type<QuestionSettings>().notNull(),
    },
    (table) => [
      questionOrganizationAccess(),
      check('question_settings_revision', sql`${table.revision} > 0`),
    ],
  )
  .enableRLS();

export const questionCategories = quizGame
  .table(
    'question_categories',
    {
      id: uuid().primaryKey(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      name: text().notNull(),
      active: boolean().notNull().default(true),
      revision: integer().notNull().default(1),
    },
    (table) => [
      questionOrganizationAccess(),
      unique().on(table.instanceId, table.name),
      unique().on(table.instanceId, table.id),
    ],
  )
  .enableRLS();

export const questionSubmissions = quizGame
  .table(
    'question_submissions',
    {
      authorName: text('author_name').notNull().default('作問者'),
      provenance: jsonb('provenance').$type<{
        author: string;
        instance: string;
      } | null>(),
      deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
      reviewHold: boolean('review_hold').notNull().default(false),
      id: uuid().primaryKey(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      seriesId: uuid('series_id').notNull(),
      authorId: text('author_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      revision: integer().notNull().default(1),
      status: text().$type<SubmissionStatus>().notNull().default('draft'),
      input: jsonb().$type<QuestionInput>().notNull(),
      reason: text().notNull().default(''),
      publishedId: uuid('published_id'),
      stopped: boolean().notNull().default(false),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      questionOrganizationAccess(),
      index().on(table.instanceId, table.authorId),
      index().on(table.instanceId, table.status),
      check('question_submission_revision', sql`${table.revision} > 0`),
      check(
        'question_submission_status',
        sql`${table.status} IN ('draft','pending','returned','approved','rejected','ended')`,
      ),
    ],
  )
  .enableRLS();

export const questionSubmissionEvents = quizGame
  .table(
    'question_submission_events',
    {
      id: uuid().primaryKey(),
      submissionId: uuid('submission_id')
        .notNull()
        .references(() => questionSubmissions.id),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      revision: integer().notNull(),
      actorId: text('actor_id').notNull(),
      action: text().notNull(),
      input: jsonb().$type<QuestionInput>().notNull(),
      reason: text().notNull(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      questionOrganizationAccess(),
      index().on(table.submissionId, table.revision),
    ],
  )
  .enableRLS();

export const questionAuthors = quizGame
  .table(
    'question_authors',
    {
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      actorId: text('actor_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      status: text().$type<'pending' | 'qualified' | 'rejected' | 'revoked'>().notNull(),
      reason: text().notNull().default(''),
      retryAt: timestamp('retry_at', { withTimezone: true, mode: 'string' }),
      revision: integer().notNull().default(1),
    },
    (table) => [
      questionOrganizationAccess(),
      primaryKey({ columns: [table.instanceId, table.actorId] }),
      check(
        'question_author_status',
        sql`${table.status} IN ('pending','qualified','rejected','revoked')`,
      ),
    ],
  )
  .enableRLS();

export const questionNotifications = quizGame
  .table(
    'question_notifications',
    {
      id: uuid().primaryKey(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      actorId: text('actor_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      message: text().notNull(),
      target: jsonb().$type<{ page: 'edit' | 'qualification'; id?: string }>(),
      read: boolean().notNull().default(false),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      questionOrganizationAccess(),
      index().on(table.instanceId, table.actorId),
    ],
  )
  .enableRLS();

export const questionTags = quizGame
  .table(
    'question_tags',
    {
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      key: text().notNull(),
      name: text().notNull(),
      aliases: jsonb().$type<string[]>().notNull().default([]),
    },
    (table) => [
      questionOrganizationAccess(),
      primaryKey({ columns: [table.instanceId, table.key] }),
    ],
  )
  .enableRLS();

export const questionImports = quizGame
  .table(
    'question_imports',
    {
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      actorId: text('actor_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      requestId: uuid('request_id').notNull(),
      hash: text().notNull(),
      ids: jsonb().$type<string[]>().notNull(),
    },
    (table) => [
      questionOrganizationAccess(),
      primaryKey({ columns: [table.instanceId, table.actorId, table.requestId] }),
    ],
  )
  .enableRLS();

export const questionReviewCases = quizGame
  .table(
    'question_review_cases',
    {
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      questionId: text('question_id').notNull(),
      kind: text().$type<'defect' | 'category'>().notNull(),
      round: integer().notNull(),
      count: integer().notNull().default(0),
      resolved: boolean().notNull().default(false),
      reason: text().notNull().default(''),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
      resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    },
    (table) => [
      primaryKey({
        columns: [table.instanceId, table.questionId, table.kind, table.round],
      }),
      questionOrganizationAccess(),
      check('review_case_kind', sql`${table.kind} IN ('defect','category')`),
    ],
  )
  .enableRLS();

export const questionReports = quizGame
  .table(
    'question_reports',
    {
      id: uuid().primaryKey(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      questionId: text('question_id').notNull(),
      kind: text().$type<'defect' | 'category'>().notNull(),
      round: integer().notNull(),
      actorId: text('actor_id').notNull(),
      reason: text().notNull(),
      suggestedCategory: text('suggested_category').notNull().default(''),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      unique().on(
        table.instanceId,
        table.questionId,
        table.kind,
        table.round,
        table.actorId,
      ),
      questionOrganizationAccess(),
      check('question_report_kind', sql`${table.kind} IN ('defect','category')`),
    ],
  )
  .enableRLS();

export const questionDifficulty = quizGame
  .table(
    'question_difficulty',
    {
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      seriesId: uuid('series_id').notNull(),
      generation: uuid().notNull(),
      current: integer().notNull(),
      fixed: boolean().notNull().default(false),
      revision: integer().notNull().default(1),
      lastDay: text('last_day'),
      cursor: text(),
      stats: jsonb()
        .$type<
          {
            band: number;
            players: number;
            rulesHash: string;
            bandRevision: number;
            trials: number;
            correct: number;
            participants: number;
            lower: number;
            upper: number;
          }[]
        >()
        .notNull()
        .default([]),
      reason: text().notNull().default('自己申告'),
    },
    (table) => [
      primaryKey({ columns: [table.instanceId, table.seriesId] }),
      questionOrganizationAccess(),
      check('question_difficulty_range', sql`${table.current} BETWEEN 0 AND 2`),
    ],
  )
  .enableRLS();

export const userReports = quizGame
  .table(
    'user_reports',
    {
      id: uuid().primaryKey(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      actorId: text('actor_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      reporterId: text('reporter_id').notNull(),
      resultId: uuid('result_id').notNull(),
      reason: text().notNull(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
      resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
      operatorId: text('operator_id'),
      resolution: text(),
    },
    (table) => [
      organizationAccess(),
      index().on(table.instanceId, table.actorId, table.resolvedAt),
      check('user_report_other', sql`${table.actorId} <> ${table.reporterId}`),
      check(
        'user_report_resolution',
        sql`(${table.resolvedAt} IS NULL AND ${table.operatorId} IS NULL AND ${table.resolution} IS NULL) OR (${table.resolvedAt} IS NOT NULL AND ${table.operatorId} IS NOT NULL AND ${table.resolution} IS NOT NULL AND char_length(btrim(${table.resolution})) BETWEEN 1 AND 1000)`,
      ),
      check(
        'user_report_reason',
        sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 1000`,
      ),
    ],
  )
  .enableRLS();
export const sanctionAppeals = quizGame
  .table(
    'sanction_appeals',
    {
      id: uuid().primaryKey(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      actorId: text('actor_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      sanctionId: uuid('sanction_id')
        .notNull()
        .references(() => moderationSanctions.id),
      sanctionRevision: integer('sanction_revision').notNull(),
      reason: text().notNull(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
      resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
      operatorId: text('operator_id'),
      resolution: text(),
      decision: text().$type<'revoke' | 'maintain'>(),
      readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
    },
    (table) => [
      organizationAccess(),
      index().on(table.actorId, table.resolvedAt),
      check('appeal_reason', sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 1000`),
      check('appeal_revision', sql`${table.sanctionRevision} > 0`),
      check(
        'appeal_decision',
        sql`${table.decision} IS NULL OR ${table.decision} IN ('maintain','revoke')`,
      ),
      check(
        'appeal_resolution',
        sql`(${table.resolvedAt} IS NULL AND ${table.operatorId} IS NULL AND ${table.resolution} IS NULL AND ${table.decision} IS NULL) OR (${table.resolvedAt} IS NOT NULL AND ${table.operatorId} IS NOT NULL AND ${table.decision} IS NOT NULL AND ${table.resolution} IS NOT NULL AND char_length(btrim(${table.resolution})) BETWEEN 1 AND 1000)`,
      ),
      uniqueIndex().on(table.sanctionId).where(sql`${table.resolvedAt} IS NULL`),
    ],
  )
  .enableRLS();
export const moderationRequests = quizGame
  .table(
    'moderation_requests',
    {
      id: uuid().primaryKey(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      operatorId: text('operator_id').notNull(),
      requestHash: text('request_hash').notNull(),
      details: jsonb().$type<Record<string, unknown>>().notNull(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    },
    () => [organizationAccess()],
  )
  .enableRLS();
export const administratorTransfers = quizGame
  .table(
    'administrator_transfers',
    {
      id: uuid().primaryKey(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      senderId: text('sender_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      targetId: text('target_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      keepSender: boolean('keep_sender').notNull(),
      readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
      state: text()
        .$type<'pending' | 'accepted' | 'cancelled'>()
        .notNull()
        .default('pending'),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
      expiresAt: timestamp('expires_at', {
        withTimezone: true,
        mode: 'string',
      }).notNull(),
    },
    (table) => [
      organizationAccess(),
      index().on(table.targetId, table.state),
      check('transfer_state', sql`${table.state} IN ('pending','accepted','cancelled')`),
      check('transfer_target', sql`${table.senderId} <> ${table.targetId}`),
    ],
  )
  .enableRLS();

export const guestSessions = quizGame
  .table(
    'guest_sessions',
    {
      actorId: text('actor_id').primaryKey(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      name: text().notNull(),
      expiresAt: timestamp('expires_at', {
        withTimezone: true,
        mode: 'string',
      }).notNull(),
    },
    (table) => [
      organizationAccess(),
      index().on(table.expiresAt),
      check('guest_actor_hash', sql`${table.actorId} ~ '^[0-9a-f]{64}$'`),
    ],
  )
  .enableRLS();

export const personalQuestionSets = quizGame
  .table(
    'personal_question_sets',
    {
      id: uuid().primaryKey(),
      organizationId: uuid('organization_id')
        .notNull()
        .references(() => organizations.id),
      authorId: text('author_id')
        .notNull()
        .references(() => organizationAccounts.actorId),
      name: text().notNull(),
      revision: integer().notNull().default(1),
      questions: jsonb().$type<BroughtQuestion[]>().notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      organizationAccess(),
      index().on(table.organizationId, table.authorId),
      check('personal_set_revision', sql`${table.revision} >= 1`),
    ],
  )
  .enableRLS();

export const roomDirectory = quizGame
  .table(
    'room_directory',
    {
      id: uuid().primaryKey(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => instances.id),
      public: boolean().notNull(),
      closed: boolean().notNull().default(false),
    },
    (table) => [
      organizationAccess(),
      index().on(table.instanceId, table.public, table.closed),
    ],
  )
  .enableRLS();
