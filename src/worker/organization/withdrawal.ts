import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  organizationAccounts as accounts,
  accountWithdrawals,
  instanceGrants,
  instances,
  personalQuestionSets,
  questionSubmissions,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { publishQuestionCatalog } from '../questions/catalog.ts';
import { OrganizationError, validId } from './access.ts';
import { type organizationDatabase, organizationIdentity } from './database.ts';

type Database = ReturnType<typeof organizationDatabase>['db'];

export async function recordWithdrawal(
  db: Pick<Database, 'transaction'>,
  subject: string,
  operationId: string,
  profile: string,
) {
  validId(operationId);
  return db.transaction(async (tx) => {
    const { organization, account } = await organizationIdentity(
      tx,
      subject,
      undefined,
      true,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`profile:${organization.id}`}, 0))`,
    );
    const scopes = await tx
      .select()
      .from(instances)
      .where(eq(instances.organizationId, organization.id))
      .orderBy(asc(instances.id));
    for (const scope of scopes)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${scope.id}`}, 0))`,
      );
    const [prior] = await tx
      .select()
      .from(accountWithdrawals)
      .where(eq(accountWithdrawals.id, operationId));
    if (prior) {
      if (prior.actorId !== account.actorId)
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      return prior;
    }
    const current = await organizationIdentity(tx, subject);
    if (current.account.administrator) {
      const administrators = await tx
        .select({ id: accounts.actorId })
        .from(accounts)
        .where(
          and(
            eq(accounts.organizationId, organization.id),
            eq(accounts.administrator, true),
            isNull(accounts.withdrawnAt),
          ),
        );
      if (administrators.length < 2)
        throw new OrganizationError('LAST_ADMINISTRATOR', 409);
    }
    await tx.execute(
      sql`select set_config('quiz.organization_id', ${organization.id}, true)`,
    );
    const [job] = await tx
      .insert(accountWithdrawals)
      .values({
        id: operationId,
        organizationId: organization.id,
        actorId: account.actorId,
      })
      .returning();
    await tx
      .update(accounts)
      .set({ withdrawnAt: job.requestedAt, displayName: null, administrator: false })
      .where(eq(accounts.actorId, account.actorId));
    await tx.delete(instanceGrants).where(eq(instanceGrants.actorId, account.actorId));
    await tx
      .delete(personalQuestionSets)
      .where(eq(personalQuestionSets.authorId, account.actorId));
    const authored = await tx
      .update(questionSubmissions)
      .set({ authorName: '退会ユーザー' })
      .where(eq(questionSubmissions.authorId, account.actorId))
      .returning({
        instanceId: questionSubmissions.instanceId,
        publishedId: questionSubmissions.publishedId,
      });
    for (const scope of scopes)
      if (authored.some((row) => row.instanceId === scope.id && row.publishedId))
        await publishQuestionCatalog(tx, scope.id, scope.owner, profile);
    return job;
  });
}

export async function withdrawAccount(
  db: Database,
  env: Env,
  subject: string,
  input: Record<string, unknown>,
) {
  const operationId = validId(input.operationId);
  if (input.confirmation !== '退会')
    throw new OrganizationError('WITHDRAWAL_CONFIRMATION', 400);
  if (input.subject !== subject)
    throw new OrganizationError('WITHDRAWAL_ACCOUNT_CHANGED', 409);
  if (!env.ACCOUNT_ERASURE) throw new OrganizationError('ERASURE_UNAVAILABLE', 503);
  const { organization, account } = await organizationIdentity(
    db,
    subject,
    undefined,
    true,
  );
  const matchmaker = env.MATCHMAKER.getByName(organization.id);
  if (
    !account.withdrawnAt &&
    (
      await db
        .select()
        .from(instances)
        .where(
          and(
            eq(instances.organizationId, organization.id),
            eq(instances.roomInventoryComplete, false),
          ),
        )
    ).length
  )
    throw new OrganizationError('ROOM_INVENTORY_REQUIRED', 409);
  try {
    const admission = await matchmaker.beginWithdrawal(account.actorId, operationId);
    if (!admission.ok) throw new OrganizationError(admission.code, 409);
    await recordWithdrawal(db, subject, operationId, env.GAME_CONFIG_PROFILE);
  } catch (error) {
    // A lost COMMIT response must not reopen admission. A failed status read also keeps it closed.
    const [committed] = await db
      .select()
      .from(accountWithdrawals)
      .where(eq(accountWithdrawals.actorId, account.actorId));
    if (!committed) await matchmaker.cancelWithdrawal(account.actorId, operationId);
    if (committed?.id !== operationId) throw error;
  }
  await matchmaker.logoutActor(account.actorId).catch(() => undefined);
  await env.ACCOUNT_ERASURE?.fetch('https://account-erasure.internal/withdrawal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationId }),
  }).catch(() => undefined);
  return { ok: true };
}
