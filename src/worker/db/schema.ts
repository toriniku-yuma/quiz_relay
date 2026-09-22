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
  uuid,
} from 'drizzle-orm/pg-core';
import type { InstancePermission } from '../../shared/organization';
import type { FixedQuestion } from '../catalog/definition.ts';
import type { Rules } from '../game/rules.ts';
import type { ResultRecord } from '../results/record';

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
  return [
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
export const organizations = quizGame
  .table(
    'organizations',
    {
      id: uuid().primaryKey(),
      singleton: boolean().notNull().default(true).unique(),
      name: text().notNull(),
      identityNamespace: text('identity_namespace').notNull().unique(),
    },
    (t) => [
      check('one_organization', sql`${t.singleton} = true`),
      check(
        'organization_name_length',
        sql`char_length(btrim(${t.name})) BETWEEN 1 AND 80`,
      ),
      check(
        'organization_namespace_length',
        sql`char_length(btrim(${t.identityNamespace})) BETWEEN 1 AND 256`,
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
    },
    (t) => [
      unique().on(t.organizationId, t.subject),
      check(
        'account_subject_length',
        sql`char_length(btrim(${t.subject})) BETWEEN 1 AND 256`,
      ),
      check('account_actor_hash', sql`${t.actorId} ~ '^[0-9a-f]{64}$'`),
      organizationAccess(),
    ],
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
      state: text().$type<'preparing' | 'published'>().notNull().default('preparing'),
    },
    (t) => [
      check('instance_name_length', sql`char_length(btrim(${t.name})) BETWEEN 1 AND 80`),
      check(
        'instance_owner_length',
        sql`char_length(btrim(${t.owner})) BETWEEN 1 AND 256`,
      ),
      index().on(t.organizationId),
      check('instance_state', sql`${t.state} IN ('preparing', 'published')`),
      organizationAccess(),
    ],
  )
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
    (t) => [
      primaryKey({ columns: [t.instanceId, t.actorId, t.permission] }),
      index().on(t.actorId),
      check(
        'instance_permission',
        sql`${t.permission} IN ('questions', 'authors', 'users')`,
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
    (t) => [
      check('organization_event_actor_hash', sql`${t.actorId} ~ '^[0-9a-f]{64}$'`),
      check(
        'organization_event_action',
        sql`${t.action} IN ('setup', 'add', 'publish', 'rename', 'grants')`,
      ),
      index().on(t.occurredAt),
      organizationAccess(),
    ],
  )
  .enableRLS();
