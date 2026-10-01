import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { instances, moderationRequests } from '../src/worker/db/schema.ts';
import { overview, publishInstance } from '../src/worker/organization/database.ts';
import { changeInstanceOperation } from '../src/worker/organization/operations.ts';
import { questionMutation } from '../src/worker/questions/database.ts';

export async function verifyInstanceOperations(
  db: PostgresJsDatabase,
  id: string,
  otherId: string,
) {
  const run = (subject: string, input: Record<string, unknown>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      return changeInstanceOperation(tx, subject, input);
    });
  const [original] = await db.select().from(instances).where(eq(instances.id, id));
  const [other] = await db.select().from(instances).where(eq(instances.id, otherId));
  const request = {
    id,
    action: 'stopRanked',
    reason: '点検',
    revision: original.operationRevision,
    operationId: crypto.randomUUID(),
  };
  await assert.rejects(run('author', request), /ADMIN_REQUIRED/);
  await assert.rejects(run('admin', { ...request, reason: '' }), /REASON_REQUIRED/);
  await run('admin', request);
  await run('admin', request);
  await assert.rejects(
    run('admin', { ...request, reason: '変更' }),
    /OPERATION_CONFLICT/,
  );
  await assert.rejects(
    run('admin', { ...request, operationId: crypto.randomUUID() }),
    /EDIT_CONFLICT/,
  );
  let revision = original.operationRevision + 1;
  for (const action of ['stopCasual', 'prepare', 'publish']) {
    await run('admin', {
      id,
      action,
      reason: '点検',
      revision: revision++,
      operationId: crypto.randomUUID(),
    });
    const [current] = await db.select().from(instances).where(eq(instances.id, id));
    assert.equal(current.rankedPauseReason, '点検');
    if (action !== 'stopCasual') assert.equal(current.casualPauseReason, '点検');
  }
  await run('admin', {
    id,
    action: 'resumeRanked',
    revision,
    operationId: crypto.randomUUID(),
  });
  const [current] = await db.select().from(instances).where(eq(instances.id, id));
  assert.equal(current.rankedPauseReason, null);
  assert.equal(current.casualPauseReason, '点検');
  assert.equal(current.state, 'published');
  revision++;
  await run('admin', {
    id,
    action: 'archive',
    revision: revision++,
    operationId: crypto.randomUUID(),
  });
  await assert.rejects(
    run('admin', { id, action: 'publish', revision, operationId: crypto.randomUUID() }),
    /EDIT_CONFLICT/,
  );
  await assert.rejects(publishInstance(db, 'admin', { id }), /INSTANCE_NOT_FOUND/);
  await assert.rejects(
    questionMutation(db, 'admin', id, { operation: 'category', name: '禁止' }),
    /INSTANCE_ARCHIVED/,
  );
  await questionMutation(db, 'author', id, { operation: 'export' });
  await questionMutation(db, 'reviewer', id, { operation: 'export-managed', all: true });
  await assert.rejects(
    questionMutation(db, 'outsider', id, { operation: 'export-managed', all: true }),
    /REVIEW_FORBIDDEN/,
  );
  const personal = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
    return overview(tx, 'author');
  });
  assert.ok(personal.instances.some((row) => row.id === id && row.state === 'archived'));
  await run('admin', {
    id,
    action: 'restore',
    revision,
    operationId: crypto.randomUUID(),
  });
  const [restored] = await db.select().from(instances).where(eq(instances.id, id));
  assert.equal(restored.state, 'preparing');
  assert.equal(restored.casualPauseReason, '点検');
  assert.deepEqual(
    (await db.select().from(instances).where(eq(instances.id, otherId)))[0],
    other,
  );
  assert.equal(
    (
      await db
        .select()
        .from(moderationRequests)
        .where(eq(moderationRequests.id, request.operationId))
    ).length,
    1,
  );
  await db.update(instances).set(original).where(eq(instances.id, id));
  console.log(
    'PASS: instance pause permissions, reason, retry, conflict, independent settings and instance isolation',
  );
}
