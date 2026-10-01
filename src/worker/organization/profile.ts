import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { normalizeDisplayName, type Profile } from '../../shared/profile.ts';
import {
  organizationAccounts as accounts,
  instances,
  questionSubmissions as submissions,
} from '../db/schema.ts';
import { publishQuestionCatalog } from '../questions/catalog.ts';
import { OrganizationError } from './access.ts';
import { type organizationDatabase, organizationIdentity } from './database.ts';

type Database = Pick<
  ReturnType<typeof organizationDatabase>['db'],
  'select' | 'insert' | 'update' | 'delete' | 'transaction'
>;

export async function currentProfileNames(
  db: Pick<Database, 'select'>,
  organizationId: string,
  actorIds: string[],
) {
  if (!actorIds.length) return new Map<string, string>();
  const rows = await db
    .select({
      actorId: accounts.actorId,
      displayName: accounts.displayName,
      withdrawnAt: accounts.withdrawnAt,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        inArray(accounts.actorId, actorIds),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.actorId,
      row.withdrawnAt ? '退会ユーザー' : (row.displayName ?? '表示名未登録'),
    ]),
  );
}

export async function saveProfile(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
  profile: string,
): Promise<Profile> {
  const displayName = normalizeDisplayName(input.displayName);
  if (
    displayName === undefined ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 0
  )
    throw new OrganizationError('INVALID_PROFILE', 400);
  return db.transaction(async (tx) => {
    const { organization, account } = await organizationIdentity(tx, subject);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`profile:${organization.id}`}, 0))`,
    );
    // Use the same locks as question edits so a concurrent save cannot restore an old author name.
    const scopes = await tx
      .select()
      .from(instances)
      .where(eq(instances.organizationId, organization.id))
      .orderBy(asc(instances.id));
    for (const scope of scopes)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${scope.id}`}, 0))`,
      );
    const [current] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.actorId, account.actorId));
    if (current.withdrawnAt) throw new OrganizationError('ACCOUNT_WITHDRAWN', 403);
    if (current.displayName === displayName)
      return { displayName, revision: current.profileRevision };
    if (current.profileRevision !== input.revision)
      throw new OrganizationError('EDIT_CONFLICT', 409);
    const [duplicate] = await tx
      .select({ id: accounts.actorId })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organization.id),
          eq(accounts.displayName, displayName),
        ),
      )
      .limit(1);
    if (duplicate) throw new OrganizationError('DISPLAY_NAME_TAKEN', 409);
    await tx.execute(
      sql`select set_config('quiz.organization_id', ${organization.id}, true)`,
    );
    await tx
      .update(accounts)
      .set({ displayName, profileRevision: current.profileRevision + 1 })
      .where(eq(accounts.actorId, current.actorId));
    const updated = await tx
      .update(submissions)
      .set({ authorName: displayName })
      .where(eq(submissions.authorId, current.actorId))
      .returning({
        instanceId: submissions.instanceId,
        publishedId: submissions.publishedId,
      });
    for (const scope of scopes)
      if (updated.some((row) => row.instanceId === scope.id && row.publishedId))
        await publishQuestionCatalog(tx, scope.id, scope.owner, profile);
    return { displayName, revision: current.profileRevision + 1 };
  });
}
