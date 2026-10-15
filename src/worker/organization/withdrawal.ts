import { and, eq, isNull, sql } from 'drizzle-orm';
import { changeD1, type Database } from '../db/d1.ts';
import {
  accountInstanceSelections,
  organizationAccounts as accounts,
  accountWithdrawals,
  federationFavorites,
  instanceGrants,
  instances,
  matches,
  personalQuestionSets,
  questionSubmissions,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { planControlEvent } from '../federation/controls.ts';
import { OrganizationError, validId } from './access.ts';
import { organizationIdentity } from './database.ts';

export async function recordWithdrawal(
  db: Database,
  subject: string,
  operationId: string,
  _profile: string,
) {
  validId(operationId);
  return changeD1(db, async (writes) => {
    const tx = db;
    const { organization, account } = await organizationIdentity(
      tx,
      subject,
      undefined,
      true,
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
    const [active] = await tx
      .select({ id: matches.matchId })
      .from(matches)
      .where(
        and(
          eq(matches.status, 'running'),
          sql`exists(select 1 from json_each(${matches.payload}, '$.players') player where json_extract(player.value, '$.id')=${account.actorId})`,
        ),
      )
      .limit(1);
    if (active) throw new OrganizationError('RESULT_OR_MATCH_PENDING', 409);
    const now = new Date().toISOString();
    const job: typeof accountWithdrawals.$inferSelect = {
      id: operationId,
      organizationId: organization.id,
      actorId: account.actorId,
      requestedAt: now,
      authDeletedAt: null,
      erasedAt: null,
      auditErasedAt: null,
      retryAt: now,
      attempts: 0,
      roomCursor: null,
      lastAttemptAt: '1970-01-01T00:00:00.000Z',
    };
    writes.push(tx.insert(accountWithdrawals).values(job));
    await planControlEvent(tx, writes, {
      version: 1,
      eventId: operationId,
      type: 'withdrawal',
      subjectId: account.actorId,
      createdAt: Date.parse(now),
    });
    writes.push(
      tx
        .update(accounts)
        .set({ withdrawnAt: job.requestedAt, displayName: null, administrator: false })
        .where(eq(accounts.actorId, account.actorId)),
    );
    // Queue this organization's original results once; routine expiry uses the due index.
    writes.push(
      sql`insert into quiz_game_result_privacy_jobs (match_id,due_at) select match_id,${now} from quiz_game_matches where owner in (select owner from quiz_game_instances where organization_id=${organization.id}) on conflict(match_id) do update set due_at=min(due_at,excluded.due_at)`,
    );
    writes.push(
      tx.delete(instanceGrants).where(eq(instanceGrants.actorId, account.actorId)),
      tx
        .delete(federationFavorites)
        .where(eq(federationFavorites.actorId, account.actorId)),
    );
    writes.push(
      tx
        .delete(accountInstanceSelections)
        .where(eq(accountInstanceSelections.actorId, account.actorId)),
    );
    writes.push(
      tx
        .delete(personalQuestionSets)
        .where(eq(personalQuestionSets.authorId, account.actorId)),
    );
    writes.push(
      tx
        .update(questionSubmissions)
        .set({ authorName: '退会ユーザー' })
        .where(eq(questionSubmissions.authorId, account.actorId)),
    );
    // Catalog readers project retired author names immediately; erasure clears saved names later.
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
