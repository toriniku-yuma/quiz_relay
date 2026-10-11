import { eq, isNotNull, sql } from 'drizzle-orm';
import { changeD1, type Database, readD1, rowBatchesD1 } from '../worker/db/d1.ts';
import {
  accountInstanceSelections,
  accountWithdrawals,
  federationFavorites,
  instanceDeletions,
  instanceGrants,
  instances,
  organizationAccounts,
  organizations,
  personalQuestionSets,
} from '../worker/db/schema.ts';
import { actorForSubject } from '../worker/organization/access.ts';

export async function exportPrivacyJournal(db: Database) {
  return readD1(db, async () => {
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
  });
}
type Journal = Awaited<ReturnType<typeof exportPrivacyJournal>>;

// Offline recovery only. Keep this out of public routes and stop traffic before running it.
export async function restorePrivacyJournal(db: Database, input: unknown) {
  const journal = input as Journal;
  if (
    journal?.version !== 1 ||
    !Array.isArray(journal.withdrawals) ||
    !Array.isArray(journal.deletions)
  )
    throw new Error('INVALID_PRIVACY_JOURNAL');
  const actors = new Set<string>(),
    operations = new Set<string>(),
    owners = new Set<string>();
  for (const { job, subject } of journal.withdrawals) {
    if (
      !job ||
      job.organizationId !== journal.organizationId ||
      typeof subject !== 'string' ||
      !subject ||
      job.actorId !== (await actorForSubject(journal.namespace, subject)) ||
      !Number.isFinite(Date.parse(job.requestedAt)) ||
      !/^[0-9a-f-]{36}$/.test(job.id) ||
      actors.has(job.actorId) ||
      operations.has(job.id)
    )
      throw new Error('INVALID_WITHDRAWAL_RECEIPT');
    actors.add(job.actorId);
    operations.add(job.id);
  }
  for (const job of journal.deletions) {
    if (
      !job ||
      job.organizationId !== journal.organizationId ||
      !job.deletedAt ||
      !Number.isFinite(Date.parse(job.deletedAt)) ||
      !Number.isFinite(Date.parse(job.requestedAt)) ||
      !job.owner ||
      !job.name ||
      !/^[0-9a-f-]{36}$/.test(job.id) ||
      !/^[0-9a-f-]{36}$/.test(job.instanceId) ||
      owners.has(job.owner) ||
      operations.has(job.id)
    )
      throw new Error('INVALID_DELETION_RECEIPT');
    owners.add(job.owner);
    operations.add(job.id);
  }
  return changeD1(db, async (writes) => {
    const [organization] = await db.select().from(organizations);
    if (
      !organization ||
      organization.id !== journal.organizationId ||
      organization.identityNamespace !== journal.namespace
    )
      throw new Error('PRIVACY_JOURNAL_ORGANIZATION_MISMATCH');
    const accounts = await db
      .select()
      .from(organizationAccounts)
      .where(eq(organizationAccounts.organizationId, organization.id));
    const previousWithdrawals = await db.select().from(accountWithdrawals);
    const previousDeletions = await db.select().from(instanceDeletions);
    const scopes = await db
      .select()
      .from(instances)
      .where(eq(instances.organizationId, organization.id));
    const accountRows: (typeof organizationAccounts.$inferInsert)[] = [];
    const withdrawalRows: (typeof accountWithdrawals.$inferInsert)[] = [];
    const deletionRows: (typeof instanceDeletions.$inferInsert)[] = [];
    for (const { job, subject } of journal.withdrawals) {
      const account = accounts.find(
        (row) => row.actorId === job.actorId || row.subject === subject,
      );
      if (
        account &&
        (account.actorId !== job.actorId ||
          account.subject !== subject ||
          account.organizationId !== organization.id)
      )
        throw new Error('WITHDRAWAL_RECEIPT_CONFLICT');
      const previous = previousWithdrawals.find(
        (row) => row.actorId === job.actorId || row.id === job.id,
      );
      if (
        previous &&
        (previous.id !== job.id ||
          previous.actorId !== job.actorId ||
          previous.organizationId !== organization.id ||
          previous.requestedAt !== job.requestedAt)
      )
        throw new Error('WITHDRAWAL_RECEIPT_CONFLICT');
      accountRows.push({
        ...account,
        organizationId: organization.id,
        subject,
        actorId: job.actorId,
        withdrawnAt: account?.withdrawnAt ?? job.requestedAt,
        displayName: null,
        administrator: false,
      });
      withdrawalRows.push({
        ...previous,
        id: job.id,
        organizationId: organization.id,
        actorId: job.actorId,
        requestedAt: job.requestedAt,
        authDeletedAt: null,
        erasedAt: null,
        auditErasedAt: null,
        roomCursor: null,
        lastAttemptAt: '1970-01-01T00:00:00.000Z',
        retryAt: new Date().toISOString(),
      });
    }
    for (const job of journal.deletions) {
      const instance = scopes.find(
        (row) => row.id === job.instanceId || row.owner === job.owner,
      );
      if (
        instance &&
        (instance.id !== job.instanceId ||
          instance.owner !== job.owner ||
          instance.organizationId !== organization.id)
      )
        throw new Error('DELETION_RECEIPT_CONFLICT');
      const previous = previousDeletions.find(
        (row) =>
          row.instanceId === job.instanceId ||
          row.id === job.id ||
          row.owner === job.owner,
      );
      if (
        previous &&
        (previous.id !== job.id ||
          previous.instanceId !== job.instanceId ||
          previous.owner !== job.owner ||
          previous.organizationId !== organization.id ||
          previous.name !== job.name ||
          previous.operatorId !== job.operatorId ||
          previous.requestedAt !== job.requestedAt ||
          (previous.deletedAt && previous.deletedAt !== job.deletedAt))
      )
        throw new Error('DELETION_RECEIPT_CONFLICT');
      deletionRows.push({
        ...previous,
        id: job.id,
        instanceId: job.instanceId,
        organizationId: job.organizationId,
        owner: job.owner,
        name: job.name,
        operatorId: job.operatorId,
        requestedAt: job.requestedAt,
        deletedAt: job.deletedAt,
        acceptedAt: previous?.acceptedAt ?? job.acceptedAt ?? job.deletedAt,
        checkCursor: null,
        roomCursor: null,
        inventoryPending: true,
        lastAttemptAt: '1970-01-01T00:00:00.000Z',
      });
    }
    writes.push(
      db
        .update(instances)
        .set({ state: 'preparing', roomInventoryComplete: false })
        .where(eq(instances.organizationId, organization.id)),
    );
    if (accountRows.length)
      writes.push(...rowBatchesD1(organizationAccounts, accountRows, true));
    if (withdrawalRows.length)
      writes.push(...rowBatchesD1(accountWithdrawals, withdrawalRows, true));
    // Match deleted scope metadata before installing its irreversible deletion receipt.
    for (const job of journal.deletions)
      writes.push(
        db
          .update(instances)
          .set({ state: 'archived', name: job.name })
          .where(eq(instances.id, job.instanceId)),
      );
    if (deletionRows.length)
      writes.push(...rowBatchesD1(instanceDeletions, deletionRows, true));
    const withdrawn = sql`select ${organizationAccounts.actorId} from ${organizationAccounts} where ${organizationAccounts.withdrawnAt} is not null`;
    writes.push(
      db.delete(instanceGrants).where(sql`${instanceGrants.actorId} in (${withdrawn})`),
      db
        .delete(federationFavorites)
        .where(sql`${federationFavorites.actorId} in (${withdrawn})`),
      db
        .delete(accountInstanceSelections)
        .where(sql`${accountInstanceSelections.actorId} in (${withdrawn})`),
      db
        .delete(personalQuestionSets)
        .where(sql`${personalQuestionSets.authorId} in (${withdrawn})`),
    );
  });
}
