import assert from 'node:assert/strict';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { exportPrivacyJournal, restorePrivacyJournal } from '../src/erasure/recovery.ts';
import {
  accountInstanceSelections,
  instanceGrants,
  instances,
  moderationSanctions,
  organizationAccounts,
  organizations,
} from '../src/worker/db/schema.ts';
import { actorForSubject } from '../src/worker/organization/access.ts';
import {
  organizationIdentity,
  overview,
  resolveInstance,
  setInstanceSelection,
} from '../src/worker/organization/database.ts';
import { recordWithdrawal } from '../src/worker/organization/withdrawal.ts';

// Runs only in check-question-database's fresh isolated cluster.
export async function verifyInstanceSelections(db: PostgresJsDatabase) {
  const [organization] = await db.select().from(organizations);
  const subject = 'selection-user',
    otherSubject = 'selection-other';
  const { account } = await organizationIdentity(db, subject);
  const other = await organizationIdentity(db, otherSubject);
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await db.insert(instances).values(
    ids.map((id, i) => ({
      id,
      organizationId: organization.id,
      owner: `urn:uuid:${id}`,
      name: `切替検証${i}`,
      state: i === 2 ? ('preparing' as const) : ('published' as const),
    })),
  );
  const change = (who: string, id: string, added: unknown, actorId?: string) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      return setInstanceSelection(tx, who, { id, added, actorId });
    });
  const read = (who: string) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      return overview(tx, who);
    });

  assert.deepEqual((await read(subject)).addedInstanceIds, []);
  assert.ok((await read(subject)).instances.some((instance) => instance.id === ids[0]));
  assert.equal((await resolveInstance(db, subject, ids[0])).instance.id, ids[0]);
  await Promise.all([change(subject, ids[0], true), change(subject, ids[1], true)]);
  await change(subject, ids[0], true);
  assert.deepEqual(
    (await read(subject)).addedInstanceIds?.sort(),
    ids.slice(0, 2).sort(),
  );
  assert.deepEqual((await read(otherSubject)).addedInstanceIds, []);
  assert.equal(
    (
      await db
        .select()
        .from(instanceGrants)
        .where(eq(instanceGrants.actorId, account.actorId))
    ).length,
    0,
  );
  assert.equal((await read(subject)).account?.administrator, false);

  const sanctionIds = Array.from({ length: 5 }, () => crypto.randomUUID());
  await db.insert(moderationSanctions).values([
    {
      id: sanctionIds[0],
      organizationId: organization.id,
      actorId: account.actorId,
      instanceId: ids[0],
      kind: 'partial',
      restrictions: ['ranked'],
      reason: '本人の部分制限',
    },
    {
      id: sanctionIds[1],
      organizationId: organization.id,
      actorId: account.actorId,
      instanceId: null,
      kind: 'ban',
      restrictions: [],
      reason: '組織全体の制限',
    },
    {
      id: sanctionIds[2],
      organizationId: organization.id,
      actorId: other.account.actorId,
      instanceId: ids[0],
      kind: 'partial',
      restrictions: ['casual'],
      reason: '別人の制限',
    },
    {
      id: sanctionIds[3],
      organizationId: organization.id,
      actorId: account.actorId,
      instanceId: ids[0],
      kind: 'timeout',
      restrictions: [],
      reason: '期限切れ',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    },
    {
      id: sanctionIds[4],
      organizationId: organization.id,
      actorId: account.actorId,
      instanceId: ids[0],
      kind: 'ban',
      restrictions: [],
      reason: '解除済み',
      revokedAt: new Date().toISOString(),
    },
  ]);
  const ownSanctions = (await read(subject)).sanctions;
  assert.deepEqual(
    ownSanctions?.map((row) => row.id).sort(),
    sanctionIds.slice(0, 2).sort(),
  );
  assert.ok(ownSanctions?.every((row) => row.actorId === account.actorId));
  assert.deepEqual(
    (await read(otherSubject)).sanctions?.map((row) => row.id),
    [sanctionIds[2]],
  );
  await db
    .delete(moderationSanctions)
    .where(inArray(moderationSanctions.id, sanctionIds));

  await assert.rejects(change(subject, ids[2], true), /INSTANCE_NOT_FOUND/);
  await assert.rejects(change(subject, crypto.randomUUID(), true), /INSTANCE_NOT_FOUND/);
  await assert.rejects(change(subject, ids[0], 'true'), /INVALID_OPERATION/);
  await assert.rejects(change(subject, '../unknown', true), /INVALID_INSTANCE/);
  await change(otherSubject, ids[0], true, account.actorId);
  await change(subject, ids[0], false, other.account.actorId);
  await change(subject, ids[0], false);
  assert.deepEqual((await read(subject)).addedInstanceIds, [ids[1]]);
  assert.deepEqual((await read(otherSubject)).addedInstanceIds, [ids[0]]);

  await db.update(instances).set({ state: 'published' }).where(eq(instances.id, ids[2]));
  assert.ok((await read(subject)).instances.some((instance) => instance.id === ids[2]));
  assert.deepEqual((await read(subject)).addedInstanceIds, [ids[1]]);
  await db.update(instances).set({ state: 'preparing' }).where(eq(instances.id, ids[1]));
  assert.ok(!(await read(subject)).instances.some((instance) => instance.id === ids[1]));
  assert.deepEqual((await read(subject)).addedInstanceIds, [ids[1]]);
  await change(subject, ids[1], false);
  assert.deepEqual((await read(subject)).addedInstanceIds, []);
  await db.update(instances).set({ state: 'published' }).where(eq(instances.id, ids[1]));
  assert.deepEqual((await read(subject)).addedInstanceIds, []);

  for (const role of ['anon', 'authenticated', 'quiz_game_reader'])
    assert.equal(
      (
        await db.execute(
          sql`select has_table_privilege(${role}, 'quiz_game.account_instance_selections', 'SELECT') as allowed`,
        )
      )[0].allowed,
      false,
    );
  await change(otherSubject, ids[2], true);
  await db.delete(instances).where(eq(instances.id, ids[2]));
  assert.deepEqual((await read(otherSubject)).addedInstanceIds, [ids[0]]);
  await change(subject, ids[0], true);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
    await recordWithdrawal(tx, subject, crypto.randomUUID(), 'default');
  });
  const rows = () =>
    db
      .select()
      .from(accountInstanceSelections)
      .where(eq(accountInstanceSelections.actorId, account.actorId));
  assert.equal((await rows()).length, 0);
  await assert.rejects(change(subject, ids[0], true), /ACCOUNT_WITHDRAWN/);
  await db
    .insert(accountInstanceSelections)
    .values({ actorId: account.actorId, instanceId: ids[0] });
  await restorePrivacyJournal(db, await exportPrivacyJournal(db));
  assert.equal((await rows()).length, 0);
  assert.equal(
    (
      await db
        .select()
        .from(accountInstanceSelections)
        .where(
          and(
            eq(accountInstanceSelections.actorId, other.account.actorId),
            eq(accountInstanceSelections.instanceId, ids[0]),
          ),
        )
    ).length,
    1,
  );

  const expected = await actorForSubject(organization.identityNamespace, otherSubject);
  assert.equal(expected, other.account.actorId);
  assert.equal(
    (
      await db
        .select()
        .from(organizationAccounts)
        .where(eq(organizationAccounts.actorId, expected))
    )[0].administrator,
    false,
  );
  console.log(
    'PASS: account instance selections persist, isolate users, preserve authorization, remove idempotently, clear on withdrawal/deletion/recovery, and return only own active sanctions',
  );
}
