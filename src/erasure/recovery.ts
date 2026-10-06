import { eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { connectDatabase } from '../worker/db/connection.ts';
import {
  accountInstanceSelections,
  accountWithdrawals,
  instanceDeletions,
  instances,
  organizationAccounts,
  organizations,
} from '../worker/db/schema.ts';
import { actorForSubject } from '../worker/organization/access.ts';

type Database = Pick<ReturnType<typeof connectDatabase>['db'], 'select' | 'transaction'>;
export async function exportPrivacyJournal(db: Database) {
  const [organization] = await db.select().from(organizations);
  if (!organization) throw new Error('ORGANIZATION_REQUIRED');
  return {
    version: 1 as const,
    organizationId: organization.id,
    namespace: organization.identityNamespace,
    withdrawals: await db
      .select({ job: accountWithdrawals, subject: organizationAccounts.subject })
      .from(accountWithdrawals)
      .innerJoin(
        organizationAccounts,
        eq(accountWithdrawals.actorId, organizationAccounts.actorId),
      ),
    deletions: await db
      .select()
      .from(instanceDeletions)
      .where(isNotNull(instanceDeletions.deletedAt)),
  };
}
type Journal = Awaited<ReturnType<typeof exportPrivacyJournal>>;

export async function restorePrivacyJournal(db: Database, input: unknown) {
  const journal = input as Journal;
  if (
    journal?.version !== 1 ||
    !Array.isArray(journal.withdrawals) ||
    !Array.isArray(journal.deletions)
  )
    throw new Error('INVALID_PRIVACY_JOURNAL');
  return db.transaction(async (tx) => {
    const [organization] = await tx.select().from(organizations);
    if (
      !organization ||
      organization.id !== journal.organizationId ||
      organization.identityNamespace !== journal.namespace
    )
      throw new Error('PRIVACY_JOURNAL_ORGANIZATION_MISMATCH');
    // Recovery runs with traffic stopped and migration credentials, never through the app's DB role.
    await tx
      .update(instances)
      .set({ state: 'preparing', roomInventoryComplete: false })
      .where(eq(instances.organizationId, organization.id));
    for (const { job, subject } of journal.withdrawals) {
      if (
        job.organizationId !== organization.id ||
        typeof subject !== 'string' ||
        job.actorId !==
          (await actorForSubject(organization.identityNamespace, subject)) ||
        !Number.isFinite(Date.parse(job.requestedAt))
      )
        throw new Error('INVALID_WITHDRAWAL_RECEIPT');
      await tx
        .insert(organizationAccounts)
        .values({
          organizationId: organization.id,
          subject,
          actorId: job.actorId,
          withdrawnAt: job.requestedAt,
        })
        .onConflictDoNothing();
      const [account] = await tx
        .select()
        .from(organizationAccounts)
        .where(eq(organizationAccounts.actorId, job.actorId));
      if (
        !account ||
        account.subject !== subject ||
        account.organizationId !== organization.id
      )
        throw new Error('WITHDRAWAL_RECEIPT_CONFLICT');
      if (!account.withdrawnAt)
        await tx
          .update(organizationAccounts)
          .set({ withdrawnAt: job.requestedAt, displayName: null, administrator: false })
          .where(eq(organizationAccounts.actorId, job.actorId));
      const [previous] = await tx
        .select()
        .from(accountWithdrawals)
        .where(
          or(
            eq(accountWithdrawals.actorId, job.actorId),
            eq(accountWithdrawals.id, job.id),
          ),
        );
      if (
        previous &&
        (previous.id !== job.id ||
          previous.actorId !== job.actorId ||
          previous.organizationId !== organization.id)
      )
        throw new Error('WITHDRAWAL_RECEIPT_CONFLICT');
      await tx
        .insert(accountWithdrawals)
        .values({
          id: job.id,
          organizationId: organization.id,
          actorId: job.actorId,
          requestedAt: job.requestedAt,
        })
        .onConflictDoNothing();
      await tx
        .update(accountWithdrawals)
        .set({
          authDeletedAt: null,
          erasedAt: null,
          roomCursor: null,
          lastAttemptAt: '1970-01-01T00:00:00Z',
          retryAt: new Date().toISOString(),
        })
        .where(eq(accountWithdrawals.id, job.id));
    }
    for (const job of journal.deletions) {
      if (
        job.organizationId !== organization.id ||
        !job.deletedAt ||
        !Number.isFinite(Date.parse(job.deletedAt))
      )
        throw new Error('INVALID_DELETION_RECEIPT');
      const [instance] = await tx
        .select()
        .from(instances)
        .where(eq(instances.id, job.instanceId));
      if (
        instance &&
        (instance.owner !== job.owner || instance.organizationId !== organization.id)
      )
        throw new Error('DELETION_RECEIPT_CONFLICT');
      if (instance)
        await tx
          .update(instances)
          .set({ state: 'archived', name: job.name })
          .where(eq(instances.id, job.instanceId));
      const [previous] = await tx
        .select()
        .from(instanceDeletions)
        .where(
          or(
            eq(instanceDeletions.instanceId, job.instanceId),
            eq(instanceDeletions.id, job.id),
          ),
        );
      if (
        previous &&
        (previous.id !== job.id ||
          previous.instanceId !== job.instanceId ||
          previous.owner !== job.owner ||
          previous.organizationId !== organization.id)
      )
        throw new Error('DELETION_RECEIPT_CONFLICT');
      await tx
        .insert(instanceDeletions)
        .values({
          id: job.id,
          instanceId: job.instanceId,
          organizationId: job.organizationId,
          owner: job.owner,
          name: job.name,
          operatorId: job.operatorId,
          requestedAt: job.requestedAt,
          deletedAt: job.deletedAt,
        })
        .onConflictDoNothing();
      await tx
        .update(instanceDeletions)
        .set({
          deletedAt: job.deletedAt,
          acceptedAt: job.deletedAt,
          checkCursor: null,
          roomCursor: null,
          inventoryPending: true,
          lastAttemptAt: '1970-01-01T00:00:00Z',
        })
        .where(eq(instanceDeletions.id, job.id));
    }
    // Retired actors must never regain old author privileges through a restored grant.
    await tx.execute(
      sql`delete from quiz_game.instance_grants where actor_id in (select actor_id from quiz_game.organization_accounts where withdrawn_at is not null)`,
    );
    await tx
      .delete(accountInstanceSelections)
      .where(
        inArray(
          accountInstanceSelections.actorId,
          tx
            .select({ actorId: organizationAccounts.actorId })
            .from(organizationAccounts)
            .where(isNotNull(organizationAccounts.withdrawnAt)),
        ),
      );
  });
}
