import { sql } from 'drizzle-orm';

import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { FederationMetadata } from '../../shared/federation.ts';
import type { FederationControl } from '../../shared/federation-controls.ts';
import type {
  QuestionImportConfig,
  SharedQuestion,
} from '../../shared/federation-questions.ts';
import type { FederatedResult } from '../../shared/federation-results.ts';
import type { Restriction, Sanction, SanctionKind } from '../../shared/moderation.ts';
import type { InstancePermission } from '../../shared/organization.ts';
import type {
  QuestionInput,
  QuestionSelection,
  QuestionSettings,
  SubmissionStatus,
} from '../../shared/questions.ts';
import {
  type BroughtQuestion,
  type CasualSettings,
  defaultCasualSettings,
} from '../../shared/rooms.ts';
import type { FixedQuestion } from '../catalog/definition.ts';
import type { Rules } from '../game/rules.ts';
import type { ResultRecord } from '../results/record.ts';

export const databaseRevision = sqliteTable(
  'quiz_database_revision',
  {
    id: integer().primaryKey().notNull().default(1),
    revision: integer().notNull().default(0),
  },
  (table) => [check('database_revision_singleton', sql`${table.id} = 1`)],
);

export const probeRuns = sqliteTable(
  'quiz_probe_runs',
  {
    id: text().primaryKey().notNull(),
    createdAt: text('created_at')
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
      .notNull(),
  },
  () => [],
);

export const questionAvailability = sqliteTable(
  'quiz_game_question_availability',
  {
    owner: text().notNull(),
    questionId: text('question_id').notNull(),
    retiredAt: text('retired_at'),
  },
  (table) => [
    primaryKey({
      columns: [table.owner, table.questionId],
      name: 'question_availability_pkey',
    }),
    check(
      'question_availability_owner_check',
      sql`(length(owner) >= 1) AND (length(owner) <= 256)`,
    ),
    check(
      'question_availability_question_id_check',
      sql`(length(question_id) BETWEEN 1 AND 64 AND question_id NOT GLOB '*[^a-zA-Z0-9_-]*')`,
    ),
  ],
);

export const questionSets = sqliteTable(
  'quiz_game_question_sets',
  {
    owner: text().notNull(),
    setId: text('set_id').notNull(),
    version: integer().notNull(),
    manifestHash: text('manifest_hash').notNull(),
    selection: text({ mode: 'json' }).$type<QuestionSelection>(),
  },
  (table) => [
    primaryKey({
      columns: [table.owner, table.setId, table.version],
      name: 'question_sets_pkey',
    }),
    check(
      'question_sets_manifest_hash_check',
      sql`(length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      'question_sets_owner_check',
      sql`(length(owner) >= 1) AND (length(owner) <= 256)`,
    ),
    check(
      'question_sets_set_id_check',
      sql`(length(set_id) BETWEEN 1 AND 64 AND set_id NOT GLOB '*[^a-zA-Z0-9_-]*')`,
    ),
    check('question_sets_version_check', sql`version > 0`),
  ],
);

export const questionVersions = sqliteTable(
  'quiz_game_question_versions',
  {
    owner: text().notNull(),
    questionId: text('question_id').notNull(),
    version: integer().notNull(),
    payload: text({ mode: 'json' }).$type<FixedQuestion>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.owner, table.questionId, table.version],
      name: 'question_versions_pkey',
    }),
    check(
      'question_versions_check',
      sql`(json_type(payload) = 'object') AND (length(CAST(payload AS BLOB)) <= 16384) AND ((payload ->> 'id') = question_id) AND (CAST(payload ->> 'version' AS INTEGER) = version) AND (json_type(payload, '$.id') IS NOT NULL) AND (json_type(payload, '$.version') IS NOT NULL)`,
    ),
    check(
      'question_versions_owner_check',
      sql`(length(owner) >= 1) AND (length(owner) <= 256)`,
    ),
    check(
      'question_versions_question_id_check',
      sql`(length(question_id) BETWEEN 1 AND 64 AND question_id NOT GLOB '*[^a-zA-Z0-9_-]*')`,
    ),
    check('question_versions_version_check', sql`version = 1`),
  ],
);

export const matchmakingSettings = sqliteTable(
  'quiz_game_matchmaking_settings',
  {
    owner: text().notNull(),
    profile: text().notNull(),
    competitionId: text('competition_id').notNull(),
    competitionVersion: integer('competition_version').notNull(),
  },
  (table) => [
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
    check(
      'matchmaking_settings_profile_check',
      sql`(length(profile) BETWEEN 1 AND 64 AND profile NOT GLOB '*[^a-zA-Z0-9_-]*')`,
    ),
  ],
);

export const rulesetVersions = sqliteTable(
  'quiz_game_ruleset_versions',
  {
    owner: text().notNull(),
    rulesetId: text('ruleset_id').notNull(),
    version: integer().notNull(),
    rulesHash: text('rules_hash').notNull(),
    config: text({ mode: 'json' }).$type<Rules>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.owner, table.rulesetId, table.version],
      name: 'ruleset_versions_pkey',
    }),
    check(
      'ruleset_versions_config_check',
      sql`(json_type(config) = 'object') AND (length(CAST(config AS BLOB)) <= 4096)`,
    ),
    check(
      'ruleset_versions_owner_check',
      sql`(length(owner) >= 1) AND (length(owner) <= 256)`,
    ),
    check(
      'ruleset_versions_rules_hash_check',
      sql`(length(rules_hash) = 64 AND rules_hash NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      'ruleset_versions_ruleset_id_check',
      sql`(length(ruleset_id) BETWEEN 1 AND 64 AND ruleset_id NOT GLOB '*[^a-zA-Z0-9_-]*')`,
    ),
    check('ruleset_versions_version_check', sql`version > 0`),
  ],
);

export const questionSetItems = sqliteTable(
  'quiz_game_question_set_items',
  {
    owner: text().notNull(),
    setId: text('set_id').notNull(),
    setVersion: integer('set_version').notNull(),
    ordinal: integer().notNull(),
    questionId: text('question_id').notNull(),
    questionVersion: integer('question_version').notNull(),
  },
  (table) => [
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
    check('question_set_items_ordinal_check', sql`(ordinal >= 1) AND (ordinal <= 100)`),
  ],
);

export const competitions = sqliteTable(
  'quiz_game_competitions',
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
    check(
      'competitions_competition_id_check',
      sql`(length(competition_id) BETWEEN 1 AND 64 AND competition_id NOT GLOB '*[^a-zA-Z0-9_-]*')`,
    ),
    check(
      'competitions_players_per_match_check',
      sql`(players_per_match >= 2) AND (players_per_match <= 4)`,
    ),
    check('competitions_version_check', sql`version > 0`),
  ],
);

export const matchResults = sqliteTable(
  'quiz_game_match_results',
  {
    resultId: text('result_id').primaryKey(),
    owner: text().notNull(),
    matchId: text('match_id').notNull(),
    finishedAt: text('finished_at').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payload: text({ mode: 'json' }).$type<ResultRecord>().notNull(),
  },
  (table) => [
    unique('d1_matchResults_1').on(table.owner, table.matchId),
    index('d1_matchResults_2').on(table.owner, table.finishedAt),
    check(
      'match_results_hash',
      sql`(length(${table.payloadHash}) = 64 AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*')`,
    ),
  ],
);

// An erasure permit exists only inside the batch that updates all three originals.
export const resultPrivacyChanges = sqliteTable('quiz_game_result_privacy_changes', {
  resultId: text('result_id')
    .primaryKey()
    .references(() => matchResults.resultId),
  previousHash: text('previous_hash').notNull(),
  payloadHash: text('payload_hash').notNull(),
  payload: text({ mode: 'json' }).$type<ResultRecord>().notNull(),
});

export const resultPlayers = sqliteTable(
  'quiz_game_result_players',
  {
    resultId: text('result_id')
      .notNull()
      .references(() => matchResults.resultId),
    actorId: text('actor_id').notNull(),
    name: text().notNull(),
    ratingDelta: integer('rating_delta').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.resultId, table.actorId] }),
    index('d1_resultPlayers_1').on(table.actorId),
    check('result_players_delta', sql`${table.ratingDelta} IN (-20, 0, 20)`),
  ],
);

// 結果と同じバッチで保存する配送用の原本。
export const resultOutbox = sqliteTable(
  'quiz_game_result_outbox',
  {
    resultId: text('result_id')
      .primaryKey()
      .references(() => matchResults.resultId),
    payloadHash: text('payload_hash').notNull(),
    payload: text({ mode: 'json' }).$type<ResultRecord>().notNull(),
  },
  () => [],
);

export const moderationSanctions = sqliteTable(
  'quiz_game_moderation_sanctions',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    instanceId: text('instance_id').references(() => instances.id),
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    kind: text().$type<SanctionKind>().notNull(),
    restrictions: text({ mode: 'json' }).$type<Restriction[]>().notNull(),
    reason: text().notNull(),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    revision: integer().notNull().default(1),
  },
  (table) => [
    index('d1_moderationSanctions_1').on(table.actorId, table.instanceId),
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
);
export const moderationEvents = sqliteTable(
  'quiz_game_moderation_events',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    instanceId: text('instance_id').references(() => instances.id),
    actorId: text('actor_id').notNull(),
    operatorId: text('operator_id').notNull(),
    action: text().$type<'add' | 'change' | 'revoke' | 'inspect'>().notNull(),
    reason: text().notNull(),
    requestHash: text('request_hash').notNull(),
    before: text({ mode: 'json' }).$type<Sanction>(),
    after: text({ mode: 'json' }).$type<Sanction>(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    readAt: text('read_at'),
  },
  (table) => [
    index('d1_moderationEvents_1').on(table.actorId, table.createdAt),
    check(
      'moderation_action',
      sql`${table.action} IN ('add','change','revoke','inspect')`,
    ),
  ],
);
export const organizations = sqliteTable(
  'quiz_game_organizations',
  {
    id: text().primaryKey(),
    singleton: integer({ mode: 'boolean' }).notNull().default(true).unique(),
    name: text().notNull(),
    identityNamespace: text('identity_namespace').notNull().unique(),
    externalParticipation: text('external_participation', {
      enum: ['approved', 'unblocked'],
    })
      .notNull()
      .default('approved'),
    federationRevision: integer('federation_revision').notNull().default(1),
  },
  (table) => [
    check('one_organization', sql`${table.singleton} = true`),
    check('organization_name_length', sql`length(trim(${table.name})) BETWEEN 1 AND 80`),
    check(
      'organization_namespace_length',
      sql`length(trim(${table.identityNamespace})) BETWEEN 1 AND 256`,
    ),
  ],
);
export const organizationAccounts = sqliteTable(
  'quiz_game_organization_accounts',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    subject: text().notNull(),
    actorId: text('actor_id').primaryKey(),
    administrator: integer({ mode: 'boolean' }).notNull().default(false),
    displayName: text('display_name'),
    profileRevision: integer('profile_revision').notNull().default(0),
    withdrawnAt: text('withdrawn_at'),
  },
  (table) => [
    unique('d1_organizationAccounts_1').on(table.organizationId, table.subject),
    unique('organization_display_name_unique').on(
      table.organizationId,
      table.displayName,
    ),
    check('profile_revision_valid', sql`${table.profileRevision} >= 0`),
    check(
      'account_subject_length',
      sql`length(trim(${table.subject})) BETWEEN 1 AND 256`,
    ),
    check(
      'account_actor_hash',
      sql`(length(${table.actorId}) = 64 AND ${table.actorId} NOT GLOB '*[^0-9a-f]*')`,
    ),
  ],
);
export const accountWithdrawals = sqliteTable(
  'quiz_game_account_withdrawals',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    actorId: text('actor_id')
      .notNull()
      .unique()
      .references(() => organizationAccounts.actorId),
    requestedAt: text('requested_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    authDeletedAt: text('auth_deleted_at'),
    erasedAt: text('erased_at'),
    auditErasedAt: text('audit_erased_at'),
    retryAt: text('retry_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    attempts: integer().notNull().default(0),
    roomCursor: text('room_cursor'),
    lastAttemptAt: text('last_attempt_at')
      .notNull()
      .default(sql`'1970-01-01T00:00:00.000Z'`),
  },
  () => [],
);

export const instances = sqliteTable(
  'quiz_game_instances',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id')
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
    casualConfig: text('casual_config', { mode: 'json' })
      .$type<CasualSettings>()
      .notNull()
      .default(defaultCasualSettings),
    roomInventoryComplete: integer('room_inventory_complete', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  (table) => [
    check('instance_name_length', sql`length(trim(${table.name})) BETWEEN 1 AND 80`),
    check('instance_owner_length', sql`length(trim(${table.owner})) BETWEEN 1 AND 256`),
    index('d1_instances_1').on(table.organizationId),
    check(
      'instance_state',
      sql`${table.state} IN ('preparing', 'published', 'archived')`,
    ),
  ],
);
export const accountInstanceSelections = sqliteTable(
  'quiz_game_account_instance_selections',
  {
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId, { onDelete: 'cascade' }),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.actorId, table.instanceId] }),
    index('d1_accountInstanceSelections_1').on(table.instanceId),
  ],
);

export const instanceRooms = sqliteTable(
  'quiz_game_instance_rooms',
  {
    roomId: text('room_id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    reviewAttemptedAt: text('review_attempted_at')
      .notNull()
      .default(sql`'1970-01-01T00:00:00.000Z'`),
  },
  (table) => [index('d1_instanceRooms_1').on(table.reviewAttemptedAt, table.roomId)],
);

export const instanceDeletions = sqliteTable(
  'quiz_game_instance_deletions',
  {
    id: text().primaryKey(),
    instanceId: text('instance_id').notNull().unique(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    owner: text().notNull(),
    name: text().notNull(),
    operatorId: text('operator_id').notNull(),
    requestedAt: text('requested_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    deletedAt: text('deleted_at'),
    acceptedAt: text('accepted_at'),
    checkCursor: text('check_cursor'),
    roomCursor: text('room_cursor'),
    inventoryPending: integer('inventory_pending', { mode: 'boolean' })
      .notNull()
      .default(false),
    lastAttemptAt: text('last_attempt_at')
      .notNull()
      .default(sql`'1970-01-01T00:00:00.000Z'`),
  },
  () => [],
);

export const roomInventoryScans = sqliteTable('quiz_game_room_inventory_scans', {
  id: text().primaryKey(),
  scopeIds: text('scope_ids', { mode: 'json' }).$type<string[]>().notNull(),
  cursor: text(),
  complete: integer({ mode: 'boolean' }).notNull().default(false),
  localHash: text('local_hash'),
});

export const instanceGrants = sqliteTable(
  'quiz_game_instance_grants',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    permission: text().$type<InstancePermission>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.actorId, table.permission] }),
    index('d1_instanceGrants_1').on(table.actorId),
    check(
      'instance_permission',
      sql`${table.permission} IN ('questions', 'authors', 'users')`,
    ),
  ],
);

// Separate from account/instance FKs so future retirement cannot erase an audit trail.
export const organizationEvents = sqliteTable(
  'quiz_game_organization_events',
  {
    id: text().primaryKey(),
    actorId: text('actor_id').notNull(),
    instanceId: text('instance_id'),
    action: text().$type<'setup' | 'add' | 'publish' | 'rename' | 'grants'>().notNull(),
    occurredAt: text('occurred_at')
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
      .notNull(),
    details: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    check(
      'organization_event_actor_hash',
      sql`(length(${table.actorId}) = 64 AND ${table.actorId} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      'organization_event_action',
      sql`${table.action} IN ('setup', 'add', 'publish', 'rename', 'grants')`,
    ),
    index('d1_organizationEvents_1').on(table.occurredAt),
  ],
);

export const questionSettings = sqliteTable(
  'quiz_game_question_settings',
  {
    instanceId: text('instance_id')
      .primaryKey()
      .references(() => instances.id),
    revision: integer().notNull().default(1),
    config: text({ mode: 'json' }).$type<QuestionSettings>().notNull(),
  },
  (table) => [check('question_settings_revision', sql`${table.revision} > 0`)],
);

export const questionCategories = sqliteTable(
  'quiz_game_question_categories',
  {
    id: text().primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    name: text().notNull(),
    active: integer({ mode: 'boolean' }).notNull().default(true),
    importOnly: integer('import_only', { mode: 'boolean' }).notNull().default(false),
    revision: integer().notNull().default(1),
  },
  (table) => [
    unique('d1_questionCategories_1').on(table.instanceId, table.name),
    unique('d1_questionCategories_2').on(table.instanceId, table.id),
  ],
);

export const questionSubmissions = sqliteTable(
  'quiz_game_question_submissions',
  {
    authorName: text('author_name').notNull().default('作問者'),
    provenance: text('provenance', { mode: 'json' }).$type<{
      author: string;
      instance: string;
    } | null>(),
    deletedAt: text('deleted_at'),
    reviewHold: integer('review_hold', { mode: 'boolean' }).notNull().default(false),
    id: text().primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    seriesId: text('series_id').notNull(),
    authorId: text('author_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    revision: integer().notNull().default(1),
    status: text().$type<SubmissionStatus>().notNull().default('draft'),
    input: text({ mode: 'json' }).$type<QuestionInput>().notNull(),
    searchText: text('search_text').notNull().default(''),
    reason: text().notNull().default(''),
    publishedId: text('published_id'),
    stopped: integer({ mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    index('d1_questionSubmissions_1').on(table.instanceId, table.authorId),
    index('d1_questionSubmissions_2').on(table.instanceId, table.status),
    check('question_submission_revision', sql`${table.revision} > 0`),
    check(
      'question_submission_status',
      sql`${table.status} IN ('draft','pending','returned','approved','rejected','ended')`,
    ),
  ],
);

export const questionSubmissionEvents = sqliteTable(
  'quiz_game_question_submission_events',
  {
    id: text().primaryKey(),
    submissionId: text('submission_id')
      .notNull()
      .references(() => questionSubmissions.id),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    revision: integer().notNull(),
    actorId: text('actor_id').notNull(),
    action: text().notNull(),
    input: text({ mode: 'json' }).$type<QuestionInput>().notNull(),
    reason: text().notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    index('d1_questionSubmissionEvents_1').on(table.submissionId, table.revision),
  ],
);

export const questionAuthors = sqliteTable(
  'quiz_game_question_authors',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    status: text().$type<'pending' | 'qualified' | 'rejected' | 'revoked'>().notNull(),
    reason: text().notNull().default(''),
    retryAt: text('retry_at'),
    revision: integer().notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.actorId] }),
    check(
      'question_author_status',
      sql`${table.status} IN ('pending','qualified','rejected','revoked')`,
    ),
  ],
);

export const questionNotifications = sqliteTable(
  'quiz_game_question_notifications',
  {
    id: text().primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    message: text().notNull(),
    target: text({ mode: 'json' }).$type<{
      page: 'edit' | 'qualification';
      id?: string;
    }>(),
    read: integer({ mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [index('d1_questionNotifications_1').on(table.instanceId, table.actorId)],
);

export const questionTags = sqliteTable(
  'quiz_game_question_tags',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    key: text().notNull(),
    name: text().notNull(),
    aliases: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.key] })],
);

export const questionImports = sqliteTable(
  'quiz_game_question_imports',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    requestId: text('request_id').notNull(),
    hash: text().notNull(),
    ids: text({ mode: 'json' }).$type<string[]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.actorId, table.requestId] }),
  ],
);

export const questionReviewCases = sqliteTable(
  'quiz_game_question_review_cases',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    questionId: text('question_id').notNull(),
    kind: text().$type<'defect' | 'category'>().notNull(),
    round: integer().notNull(),
    count: integer().notNull().default(0),
    resolved: integer({ mode: 'boolean' }).notNull().default(false),
    reason: text().notNull().default(''),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    resolvedAt: text('resolved_at'),
  },
  (table) => [
    primaryKey({
      columns: [table.instanceId, table.questionId, table.kind, table.round],
    }),
    check('review_case_kind', sql`${table.kind} IN ('defect','category')`),
  ],
);

export const questionReports = sqliteTable(
  'quiz_game_question_reports',
  {
    id: text().primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    questionId: text('question_id').notNull(),
    kind: text().$type<'defect' | 'category'>().notNull(),
    round: integer().notNull(),
    actorId: text('actor_id').notNull(),
    reason: text().notNull(),
    suggestedCategory: text('suggested_category').notNull().default(''),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    unique('d1_questionReports_1').on(
      table.instanceId,
      table.questionId,
      table.kind,
      table.round,
      table.actorId,
    ),
    check('question_report_kind', sql`${table.kind} IN ('defect','category')`),
  ],
);

export const questionDifficulty = sqliteTable(
  'quiz_game_question_difficulty',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    seriesId: text('series_id').notNull(),
    generation: text().notNull(),
    current: integer().notNull(),
    fixed: integer({ mode: 'boolean' }).notNull().default(false),
    revision: integer().notNull().default(1),
    lastDay: text('last_day'),
    statisticsRevision: integer('statistics_revision').notNull().default(0),
    cursor: text(),
    stats: text({ mode: 'json' })
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
    check('question_difficulty_range', sql`${table.current} BETWEEN 0 AND 2`),
  ],
);

export const difficultyTrials = sqliteTable(
  'quiz_game_difficulty_trials',
  {
    owner: text().notNull(),
    matchId: text('match_id').notNull(),
    questionId: text('question_id').notNull(),
    resultId: text('result_id')
      .notNull()
      .references(() => matchResults.resultId, { onDelete: 'cascade' }),
    generation: text().notNull(),
    band: integer().notNull(),
    players: integer().notNull(),
    rulesHash: text('rules_hash').notNull(),
    bandRevision: integer('band_revision').notNull(),
    correct: integer({ mode: 'boolean' }).notNull(),
    actors: text({ mode: 'json' }).$type<string[]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.owner, table.matchId, table.questionId] }),
    index('difficulty_trials_result').on(table.resultId),
    index('difficulty_trials_generation').on(table.owner, table.generation),
  ],
);
export const difficultySamples = sqliteTable(
  'quiz_game_difficulty_samples',
  {
    owner: text().notNull(),
    generation: text().notNull(),
    band: integer().notNull(),
    players: integer().notNull(),
    rulesHash: text('rules_hash').notNull(),
    bandRevision: integer('band_revision').notNull(),
    trials: integer().notNull().default(0),
    correct: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [
        table.owner,
        table.generation,
        table.band,
        table.players,
        table.rulesHash,
        table.bandRevision,
      ],
    }),
  ],
);
export const difficultyActors = sqliteTable(
  'quiz_game_difficulty_actors',
  {
    owner: text().notNull(),
    generation: text().notNull(),
    band: integer().notNull(),
    players: integer().notNull(),
    rulesHash: text('rules_hash').notNull(),
    bandRevision: integer('band_revision').notNull(),
    actorId: text('actor_id').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.owner,
        table.generation,
        table.band,
        table.players,
        table.rulesHash,
        table.bandRevision,
        table.actorId,
      ],
    }),
  ],
);
export const maintenanceCheckpoints = sqliteTable('quiz_maintenance_checkpoints', {
  id: text().primaryKey(),
  completedDay: text('completed_day').notNull(),
});
export const resultPrivacyJobs = sqliteTable(
  'quiz_game_result_privacy_jobs',
  {
    resultId: text('result_id')
      .primaryKey()
      .references(() => matchResults.resultId, { onDelete: 'cascade' }),
    dueAt: text('due_at').notNull(),
  },
  (table) => [index('result_privacy_due').on(table.dueAt, table.resultId)],
);

export const userReports = sqliteTable(
  'quiz_game_user_reports',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    reporterId: text('reporter_id').notNull(),
    resultId: text('result_id').notNull(),
    reason: text().notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    resolvedAt: text('resolved_at'),
    operatorId: text('operator_id'),
    resolution: text(),
  },
  (table) => [
    index('d1_userReports_1').on(table.instanceId, table.actorId, table.resolvedAt),
    check('user_report_other', sql`${table.actorId} <> ${table.reporterId}`),
    check(
      'user_report_resolution',
      sql`(${table.resolvedAt} IS NULL AND ${table.operatorId} IS NULL AND ${table.resolution} IS NULL) OR (${table.resolvedAt} IS NOT NULL AND ${table.operatorId} IS NOT NULL AND ${table.resolution} IS NOT NULL AND length(trim(${table.resolution})) BETWEEN 1 AND 1000)`,
    ),
    check('user_report_reason', sql`length(trim(${table.reason})) BETWEEN 1 AND 1000`),
  ],
);
export const sanctionAppeals = sqliteTable(
  'quiz_game_sanction_appeals',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    sanctionId: text('sanction_id')
      .notNull()
      .references(() => moderationSanctions.id),
    sanctionRevision: integer('sanction_revision').notNull(),
    reason: text().notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    resolvedAt: text('resolved_at'),
    operatorId: text('operator_id'),
    resolution: text(),
    decision: text().$type<'revoke' | 'maintain'>(),
    readAt: text('read_at'),
  },
  (table) => [
    index('d1_sanctionAppeals_1').on(table.actorId, table.resolvedAt),
    check('appeal_reason', sql`length(trim(${table.reason})) BETWEEN 1 AND 1000`),
    check('appeal_revision', sql`${table.sanctionRevision} > 0`),
    check(
      'appeal_decision',
      sql`${table.decision} IS NULL OR ${table.decision} IN ('maintain','revoke')`,
    ),
    check(
      'appeal_resolution',
      sql`(${table.resolvedAt} IS NULL AND ${table.operatorId} IS NULL AND ${table.resolution} IS NULL AND ${table.decision} IS NULL) OR (${table.resolvedAt} IS NOT NULL AND ${table.operatorId} IS NOT NULL AND ${table.decision} IS NOT NULL AND ${table.resolution} IS NOT NULL AND length(trim(${table.resolution})) BETWEEN 1 AND 1000)`,
    ),
    uniqueIndex('d1_sanctionAppeals_2')
      .on(table.sanctionId)
      .where(sql`${table.resolvedAt} IS NULL`),
  ],
);
export const moderationRequests = sqliteTable(
  'quiz_game_moderation_requests',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    operatorId: text('operator_id').notNull(),
    requestHash: text('request_hash').notNull(),
    details: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  () => [],
);
export const administratorTransfers = sqliteTable(
  'quiz_game_administrator_transfers',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    senderId: text('sender_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    targetId: text('target_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    keepSender: integer('keep_sender', { mode: 'boolean' }).notNull(),
    readAt: text('read_at'),
    state: text()
      .$type<'pending' | 'accepted' | 'cancelled'>()
      .notNull()
      .default('pending'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => [
    index('d1_administratorTransfers_1').on(table.targetId, table.state),
    check('transfer_state', sql`${table.state} IN ('pending','accepted','cancelled')`),
    check('transfer_target', sql`${table.senderId} <> ${table.targetId}`),
  ],
);

export const guestSessions = sqliteTable(
  'quiz_game_guest_sessions',
  {
    actorId: text('actor_id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text().notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => [
    index('d1_guestSessions_1').on(table.expiresAt),
    check(
      'guest_actor_hash',
      sql`(length(${table.actorId}) = 64 AND ${table.actorId} NOT GLOB '*[^0-9a-f]*')`,
    ),
  ],
);

export const personalQuestionSets = sqliteTable(
  'quiz_game_personal_question_sets',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    authorId: text('author_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    name: text().notNull(),
    revision: integer().notNull().default(1),
    questions: text({ mode: 'json' }).$type<BroughtQuestion[]>().notNull(),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    index('d1_personalQuestionSets_1').on(table.organizationId, table.authorId),
    check('personal_set_revision', sql`${table.revision} >= 1`),
  ],
);

export const roomDirectory = sqliteTable(
  'quiz_game_room_directory',
  {
    id: text().primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    public: integer({ mode: 'boolean' }).notNull(),
    closed: integer({ mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('d1_roomDirectory_1').on(table.instanceId, table.public, table.closed),
  ],
);

export const federationPeers = sqliteTable('quiz_federation_peers', {
  origin: text().primaryKey(),
  name: text().notNull(),
  kid: text().notNull(),
  publicKey: text('public_key').notNull(),
  approved: integer({ mode: 'boolean' }).notNull().default(false),
  discovered: integer({ mode: 'boolean' }).notNull().default(false),
  participationBlocked: integer('participation_blocked', { mode: 'boolean' })
    .notNull()
    .default(false),
  receiveRanked: integer('receive_ranked', { mode: 'boolean' }).notNull().default(true),
  receiveCasual: integer('receive_casual', { mode: 'boolean' }).notNull().default(true),
  revision: integer().notNull().default(1),
});
export const federationPeerKeys = sqliteTable(
  'quiz_federation_peer_keys',
  {
    origin: text()
      .notNull()
      .references(() => federationPeers.origin),
    kid: text().notNull(),
    publicKey: text('public_key').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.origin, table.kid] })],
);
export const federationPolicies = sqliteTable(
  'quiz_federation_policies',
  {
    id: text().primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    peerInstanceId: text('peer_instance_id').notNull(),
    sendQuestions: integer('send_questions', { mode: 'boolean' })
      .notNull()
      .default(false),
    receiveQuestions: integer('receive_questions', { mode: 'boolean' })
      .notNull()
      .default(false),
    revision: integer().notNull().default(1),
  },
  (table) => [
    unique().on(table.instanceId, table.peerOrigin, table.peerInstanceId),
    index('federation_policy_peer').on(table.peerOrigin),
  ],
);
export const federationFavorites = sqliteTable(
  'quiz_federation_favorites',
  {
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    instanceId: text('instance_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.actorId, table.peerOrigin, table.instanceId] }),
  ],
);
export const federationTargets = sqliteTable(
  'quiz_federation_targets',
  {
    sourceOrganizationId: text('source_organization_id').notNull(),
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    instanceId: text('instance_id').notNull(),
    payload: text({ mode: 'json' }).$type<FederationMetadata>().notNull(),
    checkedAt: integer('checked_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sourceOrganizationId, table.peerOrigin, table.instanceId],
    }),
  ],
);
// Durable proof of the local actor's consent, independent of transient Matchmaker slots.
export const federationParticipations = sqliteTable(
  'quiz_federation_participations',
  {
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    reservationId: text('reservation_id').notNull(),
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    sourceOrganizationId: text('source_organization_id').notNull(),
    hostInstanceId: text('host_instance_id').notNull(),
    matchId: text('match_id').notNull(),
    mode: text().$type<'ranked' | 'casual' | 'room'>().notNull(),
    authorizedAt: integer('authorized_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.peerOrigin, table.reservationId] }),
    index('federation_participation_actor').on(table.actorId, table.peerOrigin),
  ],
);
export const federationNonces = sqliteTable(
  'quiz_federation_nonces',
  {
    issuer: text().notNull(),
    purpose: text().notNull(),
    nonce: text().notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.purpose, table.nonce] }),
    index('federation_nonce_expiry').on(table.expiresAt),
  ],
);

export const federationMetadata = sqliteTable(
  'quiz_federation_metadata',
  {
    instanceId: text('instance_id').notNull(),
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    payload: text({ mode: 'json' }).$type<FederationMetadata>().notNull(),
    nextCursor: text('next_cursor'),
    lastSuccessAt: integer('last_success_at').notNull().default(0),
    errorCode: text('error_code'),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.peerOrigin] })],
);

export const federationMetadataJobs = sqliteTable(
  'quiz_federation_metadata_jobs',
  {
    instanceId: text('instance_id').notNull(),
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    nextAttemptAt: integer('next_attempt_at').notNull().default(0),
    attemptId: text('attempt_id'),
    leaseUntil: integer('lease_until').notNull().default(0),
    failures: integer().notNull().default(0),
    errorCode: text('error_code'),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.peerOrigin] }),
    index('federation_metadata_due').on(table.nextAttemptAt, table.leaseUntil),
  ],
);

export const federationActors = sqliteTable(
  'quiz_federation_actors',
  {
    actorId: text('actor_id')
      .primaryKey()
      .references(() => organizationAccounts.actorId),
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    sourceActorId: text('source_actor_id').notNull(),
    displayName: text('display_name'),
  },
  (table) => [unique().on(table.peerOrigin, table.sourceActorId)],
);
export const federationQuestionImports = sqliteTable(
  'quiz_federation_question_imports',
  {
    id: text().primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    peerOrigin: text('peer_origin').notNull(),
    sourceInstanceId: text('source_instance_id').notNull(),
    config: text({ mode: 'json' }).$type<QuestionImportConfig>().notNull(),
    revision: integer().notNull().default(1),
    enabled: integer({ mode: 'boolean' }).notNull().default(true),
    snapshot: text(),
    cursor: text(),
    activeSnapshot: text('active_snapshot'),
    lastSuccessAt: integer('last_success_at').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull().default(0),
    failures: integer().notNull().default(0),
    errorCode: text('error_code'),
    attemptId: text('attempt_id'),
    leaseUntil: integer('lease_until').notNull().default(0),
  },
  (table) => [
    index('federation_question_import_due').on(
      table.enabled,
      table.nextAttemptAt,
      table.leaseUntil,
    ),
  ],
);
export const federationQuestionSources = sqliteTable(
  'quiz_federation_question_sources',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    peerOrigin: text('peer_origin').notNull(),
    sourceInstanceId: text('source_instance_id').notNull(),
    categories: text({ mode: 'json' })
      .$type<{ id: string; name: string }[]>()
      .notNull()
      .default([]),
    lastSuccessAt: integer('last_success_at').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull().default(0),
    leaseUntil: integer('lease_until').notNull().default(0),
    errorCode: text('error_code'),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.peerOrigin, table.sourceInstanceId] }),
  ],
);
export const federationQuestionLinks = sqliteTable(
  'quiz_federation_question_links',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    peerOrigin: text('peer_origin').notNull(),
    sourceInstanceId: text('source_instance_id').notNull(),
    sourceSeriesId: text('source_series_id').notNull(),
    importId: text('import_id')
      .notNull()
      .references(() => federationQuestionImports.id),
    submissionId: text('submission_id')
      .notNull()
      .references(() => questionSubmissions.id),
    sourceQuestionId: text('source_question_id').notNull(),
    sourceHash: text('source_hash').notNull(),
    sourceCategory: text('source_category', { mode: 'json' })
      .$type<{ id: string; name: string }>()
      .notNull(),
    sourceDifficulty: integer('source_difficulty').notNull(),
    sourceAuthorId: text('source_author_id').notNull(),
    seenSnapshot: text('seen_snapshot').notNull(),
    excluded: integer({ mode: 'boolean' }).notNull().default(false),
    mappingRevision: integer('mapping_revision').notNull().default(1),
    mappingHash: text('mapping_hash').notNull().default(''),
    lastAvailableAt: integer('last_available_at').notNull().default(0),
    cachePurgedAt: integer('cache_purged_at'),
  },
  (table) => [
    primaryKey({
      columns: [
        table.instanceId,
        table.peerOrigin,
        table.sourceInstanceId,
        table.sourceSeriesId,
      ],
    }),
    unique().on(table.submissionId),
    index('federation_question_link_import').on(table.importId, table.seenSnapshot),
    index('federation_question_cache_due').on(table.cachePurgedAt, table.lastAvailableAt),
  ],
);
export const federationQuestionStaging = sqliteTable(
  'quiz_federation_question_staging',
  {
    importId: text('import_id')
      .notNull()
      .references(() => federationQuestionImports.id),
    snapshot: text().notNull(),
    seriesId: text('series_id').notNull(),
    payload: text({ mode: 'json' }).$type<SharedQuestion>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.importId, table.snapshot, table.seriesId] })],
);
export const federationReservations = sqliteTable(
  'quiz_federation_reservations',
  {
    id: text().primaryKey(),
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    operationId: text('operation_id').notNull(),
    requestHash: text('request_hash').notNull(),
    authorizationId: text('authorization_id').notNull().default(''),
    sourceOrganizationId: text('source_organization_id').notNull(),
    sourceActorId: text('source_actor_id').notNull(),
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id),
    mode: text({ enum: ['ranked', 'casual', 'room'] }).notNull(),
    displayName: text('display_name').notNull(),
    roomId: text('room_id'),
    matchId: text('match_id'),
    state: text({ enum: ['creating', 'reserved', 'exchanged', 'closed'] })
      .notNull()
      .default('creating'),
    expiresAt: integer('expires_at').notNull(),
    sessionExpiresAt: integer('session_expires_at').notNull().default(0),
    allowedUntil: integer('allowed_until').notNull().default(0),
  },
  (table) => [
    unique().on(table.peerOrigin, table.operationId),
    index('federation_reservation_actor').on(
      table.instanceId,
      table.actorId,
      table.allowedUntil,
    ),
    index('federation_reservation_expiry').on(table.state, table.expiresAt),
    index('federation_reservation_identity').on(
      table.peerOrigin,
      table.sourceActorId,
      table.state,
    ),
  ],
);
export const federationSessions = sqliteTable(
  'quiz_federation_sessions',
  {
    hash: text().primaryKey(),
    reservationId: text('reservation_id')
      .notNull()
      .references(() => federationReservations.id),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('federation_session_expiry').on(table.expiresAt)],
);
export const federationLoginSessions = sqliteTable(
  'quiz_federation_login_sessions',
  {
    hash: text().primaryKey(),
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    sourceOrganizationId: text('source_organization_id').notNull(),
    sourceActorId: text('source_actor_id').notNull(),
    displayName: text('display_name').notNull(),
    organizationName: text('organization_name').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    index('federation_login_expiry').on(table.expiresAt),
    index('federation_login_actor').on(table.peerOrigin, table.sourceActorId),
  ],
);
export const federationReservationClosures = sqliteTable(
  'quiz_federation_reservation_closures',
  {
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    operationId: text('operation_id').notNull(),
    sourceActorId: text('source_actor_id').notNull(),
    confirmed: integer({ mode: 'boolean' }).notNull().default(false),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.peerOrigin, table.operationId] }),
    index('federation_closure_expiry').on(table.expiresAt),
  ],
);

// Delivery originals outlive local instance removal and never depend on an in-memory retry.
export const federationResultDeliveries = sqliteTable(
  'quiz_federation_result_deliveries',
  {
    eventId: text('event_id').primaryKey(),
    resultId: text('result_id').notNull(),
    instanceId: text('instance_id').notNull(),
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    sourceActorId: text('source_actor_id').notNull(),
    payload: text({ mode: 'json' }).$type<FederatedResult>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    message: text(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull().default(0),
    leaseUntil: integer('lease_until').notNull().default(0),
    receivedAt: integer('received_at'),
    appliedAt: integer('applied_at'),
    errorCode: text('error_code'),
    quarantined: integer({ mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('federation_result_due').on(
      table.receivedAt,
      table.quarantined,
      table.nextAttemptAt,
    ),
    unique().on(table.resultId, table.peerOrigin, table.sourceActorId),
  ],
);
export const federationResultInbox = sqliteTable(
  'quiz_federation_result_inbox',
  {
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    eventId: text('event_id').notNull(),
    actorId: text('actor_id')
      .notNull()
      .references(() => organizationAccounts.actorId),
    sourceOrganizationId: text('source_organization_id').notNull(),
    payload: text({ mode: 'json' }).$type<FederatedResult>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    message: text().notNull(),
    receivedAt: integer('received_at').notNull(),
    appliedAt: integer('applied_at'),
    finishedAt: integer('finished_at').notNull(),
    conflictHash: text('conflict_hash'),
  },
  (table) => [
    primaryKey({ columns: [table.peerOrigin, table.eventId] }),
    index('federation_result_history').on(
      table.actorId,
      table.sourceOrganizationId,
      table.finishedAt,
      table.eventId,
    ),
  ],
);
export const federationControlDeliveries = sqliteTable(
  'quiz_federation_control_deliveries',
  {
    eventId: text('event_id').notNull(),
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    payload: text({ mode: 'json' }).$type<FederationControl>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    message: text(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull().default(0),
    leaseUntil: integer('lease_until').notNull().default(0),
    receivedAt: integer('received_at'),
    appliedAt: integer('applied_at'),
    errorCode: text('error_code'),
    quarantined: integer({ mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.peerOrigin] }),
    index('federation_control_due').on(
      table.appliedAt,
      table.quarantined,
      table.nextAttemptAt,
    ),
  ],
);
export const federationControlInbox = sqliteTable(
  'quiz_federation_control_inbox',
  {
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    eventId: text('event_id').notNull(),
    payload: text({ mode: 'json' }).$type<FederationControl>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    message: text().notNull(),
    receivedAt: integer('received_at').notNull(),
    appliedAt: integer('applied_at'),
    roomCursor: text('room_cursor'),
    conflictHash: text('conflict_hash'),
  },
  (table) => [
    primaryKey({ columns: [table.peerOrigin, table.eventId] }),
    index('federation_control_apply').on(table.appliedAt, table.receivedAt),
  ],
);
export const federationRetiredIdentities = sqliteTable(
  'quiz_federation_retired_identities',
  {
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    actorId: text('actor_id').notNull(),
    retiredAt: integer('retired_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.peerOrigin, table.actorId] })],
);
export const federationDeletedInstances = sqliteTable(
  'quiz_federation_deleted_instances',
  {
    peerOrigin: text('peer_origin')
      .notNull()
      .references(() => federationPeers.origin),
    instanceId: text('instance_id').notNull(),
    deletedAt: integer('deleted_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.peerOrigin, table.instanceId] })],
);
