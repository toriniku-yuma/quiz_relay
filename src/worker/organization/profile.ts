import { and, asc, eq, sql } from 'drizzle-orm';
import { normalizeDisplayName, type Profile } from '../../shared/profile.ts';
import { changeD1, type Database } from '../db/d1.ts';
import {
  organizationAccounts as accounts,
  instances,
  questionSubmissions as submissions,
} from '../db/schema.ts';
import { publishQuestionCatalog } from '../questions/catalog.ts';
import { OrganizationError } from './access.ts';
import { organizationIdentity } from './database.ts';
import { accountDisplayName } from './display-name.ts';

export async function currentProfileNames(
  db: Pick<Database, 'select'>,
  organizationId: string,
  actorIds: string[],
) {
  if (!actorIds.length) return new Map<string, string>();
  const rows = await db
    .select({
      actorId: accounts.actorId,
      displayName: accountDisplayName,
      withdrawnAt: accounts.withdrawnAt,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        sql`${accounts.actorId} in (select value from json_each(${JSON.stringify(actorIds)}))`,
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
  return changeD1(db, async (writes) => {
    const tx = db;
    const { organization, account } = await organizationIdentity(tx, subject);
    // The native batch revision also protects all affected question catalogs.
    const scopes = await tx
      .select()
      .from(instances)
      .where(eq(instances.organizationId, organization.id))
      .orderBy(asc(instances.id));

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
    writes.push(
      tx
        .update(accounts)
        .set({ displayName, profileRevision: current.profileRevision + 1 })
        .where(eq(accounts.actorId, current.actorId)),
    );
    const updated = (
      await tx.select().from(submissions).where(eq(submissions.authorId, current.actorId))
    ).map((row) => ({ ...row, authorName: displayName }));
    writes.push(
      tx
        .update(submissions)
        .set({ authorName: displayName })
        .where(eq(submissions.authorId, current.actorId)),
    );
    for (const scope of scopes)
      if (updated.some((row) => row.instanceId === scope.id && row.publishedId))
        await publishQuestionCatalog(
          tx,
          writes,
          scope.id,
          scope.owner,
          profile,
          undefined,
          { submissions: updated },
        );
    return { displayName, revision: current.profileRevision + 1 };
  });
}
