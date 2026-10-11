import { readFile } from 'node:fs/promises';
import { type User as ClerkUser, createClerkClient } from '@clerk/backend';
import { createClient, type User } from '@supabase/supabase-js';
import { eq, getTableColumns, inArray, is, or, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { legacySubjectPrefix } from '../src/worker/auth/clerk.ts';
import { connectDatabase } from './legacy-postgres/connection.ts';
import * as schema from './legacy-postgres/schema.ts';
import { organizationAccounts, resultPlayers } from './legacy-postgres/schema.ts';

type Account = Pick<
  typeof organizationAccounts.$inferSelect,
  'subject' | 'actorId' | 'organizationId' | 'administrator' | 'withdrawnAt'
>;

export function validateQuizMappingAccounts(
  accounts: Account[],
  legacySubject: string,
  clerkUserId: string,
  hasActivity = false,
) {
  const legacyAccounts = accounts.filter((account) => account.subject === legacySubject);
  const targetAccounts = accounts.filter((account) => account.subject === clerkUserId);
  const legacy = legacyAccounts[0];
  const target = targetAccounts[0];
  if (
    legacyAccounts.length !== 1 ||
    targetAccounts.length > 1 ||
    legacy.withdrawnAt ||
    (target &&
      (target.organizationId !== legacy.organizationId ||
        target.administrator ||
        target.withdrawnAt ||
        hasActivity))
  )
    throw new Error('QUIZ_ACCOUNT_MAPPING_CONFLICT');
  return { legacy, target };
}

// First Google login can already have created a profile. Keep that row intact;
// never hide existing game data behind a different canonical identity.
async function profileHasActivity(
  db: ReturnType<typeof connectDatabase>['db'],
  reader: ReturnType<typeof connectDatabase>['db'],
  account: Account,
) {
  const [result] = await reader
    .select({ found: sql<number>`1` })
    .from(resultPlayers)
    .where(eq(resultPlayers.actorId, account.actorId))
    .limit(1);
  if (result) return true;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('quiz.organization_id', ${account.organizationId}, true)`,
    );
    for (const table of Object.values(schema)) {
      if (
        !is(table, PgTable) ||
        table === organizationAccounts ||
        table === resultPlayers
      )
        continue;
      const actorColumns = Object.values(getTableColumns(table)).filter((column) =>
        [
          'actor_id',
          'author_id',
          'operator_id',
          'reporter_id',
          'sender_id',
          'target_id',
        ].includes(column.name),
      );
      if (!actorColumns.length) continue;
      const [row] = await tx
        .select({ found: sql<number>`1` })
        .from(table)
        .where(or(...actorColumns.map((column) => eq(column, account.actorId))))
        .limit(1);
      if (row) return true;
    }
    return false;
  });
}

export function validateClerkMapping(
  legacy: Pick<User, 'id' | 'identities'>,
  target: Pick<ClerkUser, 'id' | 'externalId' | 'externalAccounts'>,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(legacy.id))
    throw new Error('INVALID_LEGACY_SUBJECT');
  const externalId = legacySubjectPrefix + legacy.id;
  if (target.externalId !== null && target.externalId !== externalId)
    throw new Error('AUTH_MAPPING_CONFLICT');
  const googleIds =
    legacy.identities
      ?.filter((identity) => identity.provider === 'google')
      .map((identity) => identity.identity_data?.sub)
      .filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ) ?? [];
  if (
    !target.externalAccounts.some(
      (account) =>
        (account.provider === 'google' || account.provider === 'oauth_google') &&
        account.verification?.status === 'verified' &&
        googleIds.includes(account.providerUserId),
    )
  )
    throw new Error('GOOGLE_IDENTITY_MISMATCH');
  return externalId;
}

async function main() {
  const [path, mode] = process.argv.slice(2);
  if (!path || (mode && mode !== '--apply'))
    throw new Error('USAGE: map-clerk-accounts.ts <mapping.json> [--apply]');
  const input: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 100 ||
    input.some(
      (row) =>
        typeof row?.supabaseSubject !== 'string' ||
        typeof row?.clerkUserId !== 'string' ||
        !/^user_[A-Za-z0-9]+$/.test(row.clerkUserId),
    )
  )
    throw new Error('INVALID_MAPPING_FILE');
  if (
    new Set(input.map((row) => row.supabaseSubject)).size !== input.length ||
    new Set(input.map((row) => row.clerkUserId)).size !== input.length
  )
    throw new Error('DUPLICATE_MAPPING');
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (
    !process.env.SUPABASE_URL ||
    !key ||
    !process.env.CLERK_SECRET_KEY ||
    !process.env.ORGANIZATION_DATABASE_URL
  )
    throw new Error('AUTH_MAPPING_CONFIGURATION_REQUIRED');
  const legacy = createClient(process.env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const clerk = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
    telemetry: { disabled: true },
  });
  const { db, close } = connectDatabase(
    process.env.ORGANIZATION_DATABASE_URL,
    process.env.DATABASE_CA_CERT,
  );
  let reader: ReturnType<typeof connectDatabase> | undefined;
  try {
    const verified: { id: string; externalId: string }[] = [];
    for (const row of input) {
      const accounts = await db
        .select({
          subject: organizationAccounts.subject,
          actorId: organizationAccounts.actorId,
          organizationId: organizationAccounts.organizationId,
          administrator: organizationAccounts.administrator,
          withdrawnAt: organizationAccounts.withdrawnAt,
        })
        .from(organizationAccounts)
        .where(
          inArray(organizationAccounts.subject, [row.supabaseSubject, row.clerkUserId]),
        );
      const { target: profile } = validateQuizMappingAccounts(
        accounts,
        row.supabaseSubject,
        row.clerkUserId,
      );
      if (profile) {
        if (!process.env.GAME_DATABASE_URL)
          throw new Error('AUTH_MAPPING_READER_REQUIRED');
        reader ??= connectDatabase(
          process.env.GAME_DATABASE_URL,
          process.env.DATABASE_CA_CERT,
        );
        validateQuizMappingAccounts(
          accounts,
          row.supabaseSubject,
          row.clerkUserId,
          await profileHasActivity(db, reader.db, profile),
        );
      }
      const { data, error } = await legacy.auth.admin.getUserById(row.supabaseSubject);
      if (error || !data.user) throw new Error('LEGACY_AUTH_REQUIRED');
      const target = await clerk.users.getUser(row.clerkUserId);
      verified.push({
        id: target.id,
        externalId: validateClerkMapping(data.user, target),
      });
    }
    // All proof checks run before any write. Repeating after partial failure is safe.
    if (mode === '--apply')
      for (const row of verified) {
        await clerk.users.updateUser(row.id, { externalId: row.externalId });
        // Never rewrite subject/actorId/history in the game DB.
        const retained = await db
          .select({ subject: organizationAccounts.subject })
          .from(organizationAccounts)
          .where(
            eq(
              organizationAccounts.subject,
              row.externalId.slice(legacySubjectPrefix.length),
            ),
          );
        if (!retained.length) throw new Error('QUIZ_ACCOUNT_CHANGED');
      }
    console.log(
      `${verified.length}件の対応を${mode === '--apply' ? '保存' : '確認'}しました。`,
    );
  } finally {
    await reader?.close();
    await close();
  }
}

if (import.meta.main)
  main().catch((error) => {
    // SDK errors can contain personal data; do not print response bodies or identifiers.
    console.error(
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'AUTH_MAPPING_FAILED',
    );
    process.exitCode = 1;
  });
