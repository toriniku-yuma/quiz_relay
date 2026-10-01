import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eraseInstance } from '../src/erasure/instances.ts';
import { exportPrivacyJournal, restorePrivacyJournal } from '../src/erasure/recovery.ts';
import {
  instanceDeletions,
  instanceRooms,
  instances,
  matchResults,
  organizationAccounts,
  questionSubmissions,
} from '../src/worker/db/schema.ts';
import type { Env } from '../src/worker/env.ts';
import { renameInstance } from '../src/worker/organization/database.ts';
import { requestInstanceDeletion } from '../src/worker/organization/deletion.ts';
import { changeInstanceOperation } from '../src/worker/organization/operations.ts';

export async function verifyInstanceDeletion(
  db: PostgresJsDatabase,
  id: string,
  otherId: string,
) {
  const [instance] = await db.select().from(instances).where(eq(instances.id, id));
  const [other] = await db.select().from(instances).where(eq(instances.id, otherId));
  const accounts = await db.select().from(organizationAccounts);
  const otherQuestions = await db
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.instanceId, otherId));
  let safe = false,
    failBeforeSave = false,
    failAfterSave = false,
    erased = 0;
  const rooms = {
    idFromString: (value: string) => value,
    get: () => ({
      deletionStatus: async () => ({ safe }),
      eraseInstance: async () => {
        assert.ok(safe);
        erased++;
        return { ok: true };
      },
    }),
  } as unknown as Env['GAME_ROOM'];
  const env = {
    GAME_ROOM: rooms,
    ACCOUNT_ERASURE: {
      fetch: async (_url: string, input: RequestInit) => {
        if (failBeforeSave) return new Response(null, { status: 503 });
        const { operationId } = JSON.parse(String(input.body));
        let blocked = false;
        const ready = await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE quiz_erasure`);
          try {
            return await eraseInstance(tx, rooms, operationId);
          } catch (error) {
            if (error instanceof Error && error.message === 'RESULT_OR_MATCH_PENDING') {
              blocked = true;
              return false;
            }
            throw error;
          }
        });
        return new Response(null, {
          status: blocked ? 409 : failAfterSave || !ready ? 503 : 200,
        });
      },
    },
  } as unknown as Env;
  const request = {
    id,
    name: instance.name,
    revision: instance.operationRevision + 1,
    operationId: crypto.randomUUID(),
  };
  const run = (subject = 'outsider', input = request) =>
    requestInstanceDeletion(
      {
        transaction: (callback) =>
          db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
            return callback(tx);
          }),
      },
      env,
      subject,
      input,
    );
  await changeInstanceOperation(db, 'outsider', {
    id,
    action: 'archive',
    revision: instance.operationRevision,
    operationId: crypto.randomUUID(),
  });
  await assert.rejects(run('reviewer'), /ADMIN_REQUIRED/);
  await assert.rejects(
    run('outsider', { ...request, name: '違う名前' }),
    /EDIT_CONFLICT/,
  );
  await assert.rejects(run(), /ROOM_INVENTORY_REQUIRED/);
  await db
    .update(instances)
    .set({ roomInventoryComplete: true })
    .where(eq(instances.id, id));
  await db.insert(instanceRooms).values({ roomId: 'a'.repeat(64), instanceId: id });
  await assert.rejects(run(), /RESULT_OR_MATCH_PENDING/);
  assert.equal(
    (
      await db
        .select()
        .from(instanceDeletions)
        .where(eq(instanceDeletions.instanceId, id))
    ).length,
    0,
  );
  safe = true;
  failBeforeSave = true;
  await assert.rejects(run(), /DELETION_PENDING/);
  await assert.rejects(
    renameInstance(db, 'outsider', {
      id,
      expectedName: instance.name,
      name: '変更禁止',
    }),
    /INSTANCE_DELETING/,
  );
  await assert.rejects(
    changeInstanceOperation(db, 'outsider', {
      id,
      action: 'restore',
      revision: request.revision,
      operationId: crypto.randomUUID(),
    }),
    /INSTANCE_DELETING/,
  );
  failBeforeSave = false;
  failAfterSave = true;
  await assert.rejects(run(), /DELETION_PENDING/);
  failAfterSave = false;
  await run();
  assert.equal(erased, 1);
  assert.equal((await db.select().from(instances).where(eq(instances.id, id))).length, 0);
  assert.equal(
    (await db.select().from(matchResults).where(eq(matchResults.owner, instance.owner)))
      .length,
    0,
  );
  assert.equal(
    (
      await db
        .select()
        .from(questionSubmissions)
        .where(eq(questionSubmissions.instanceId, id))
    ).length,
    0,
  );
  assert.ok(
    (
      await db
        .select()
        .from(instanceDeletions)
        .where(eq(instanceDeletions.id, request.operationId))
    )[0].deletedAt,
  );
  assert.deepEqual(
    (await db.select().from(instances).where(eq(instances.id, otherId)))[0],
    other,
  );
  assert.deepEqual(await db.select().from(organizationAccounts), accounts);
  assert.deepEqual(
    await db
      .select()
      .from(questionSubmissions)
      .where(eq(questionSubmissions.instanceId, otherId)),
    otherQuestions,
  );
  const journal = await exportPrivacyJournal(db);
  await assert.rejects(
    restorePrivacyJournal(db, { ...journal, organizationId: crypto.randomUUID() }),
    /PRIVACY_JOURNAL_ORGANIZATION_MISMATCH/,
  );
  await assert.rejects(db.insert(instances).values(instance));
  // Simulate an older isolated backup in which the receipt and deletion had not happened yet.
  await db.delete(instanceDeletions).where(eq(instanceDeletions.id, request.operationId));
  await db.insert(instances).values(instance);
  await restorePrivacyJournal(db, journal);
  assert.equal(
    (await db.select().from(instances).where(eq(instances.id, id)))[0].state,
    'archived',
  );
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quiz_erasure`);
    await tx.execute(sql`select quiz_game.confirm_room_inventory(${id}::uuid)`);
    await eraseInstance(tx, rooms, request.operationId);
  });
  assert.equal((await db.select().from(instances).where(eq(instances.id, id))).length, 0);
  assert.equal(
    (
      await db
        .select()
        .from(instanceDeletions)
        .where(eq(instanceDeletions.id, request.operationId))
    )[0].deletedAt,
    journal.deletions.find((job) => job.id === request.operationId)?.deletedAt,
  );
  console.log(
    'PASS: archive/name/administrator/inventory guards, active or unsaved room rejection, deletion retry after lost response, deletion receipt and shared account/other instance preservation',
  );
}
