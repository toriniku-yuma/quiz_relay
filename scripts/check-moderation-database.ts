import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sanctionRevision } from '../src/shared/moderation.ts';
import {
  instanceGrants,
  matchResults,
  moderationEvents,
  moderationSanctions,
  questionSubmissions,
  resultOutbox,
  resultPlayers,
} from '../src/worker/db/schema.ts';
import { bulkSanctions } from '../src/worker/organization/bulk.ts';
import {
  moderationOverview,
  mutateSanction,
  personalModeration,
  requireUnrestricted,
} from '../src/worker/organization/moderation.ts';
import { questionMutation } from '../src/worker/questions/database.ts';

export async function verifyModeration(
  db: PostgresJsDatabase,
  input: {
    organizationId: string;
    instanceId: string;
    otherId: string;
    actors: string[];
  },
) {
  const { instanceId, otherId, actors } = input;
  const run = <T>(fn: (tx: PostgresJsDatabase) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      return fn(tx);
    });
  const mutate = (subject: string, body: Record<string, unknown>) =>
    run((tx) => mutateSanction(tx, subject, body));
  const overview = (subject: string, body: Record<string, unknown>) =>
    run((tx) => moderationOverview(tx, subject, body));
  const original = await db.select().from(questionSubmissions);
  const originalResults = await db.select().from(matchResults);
  const originalPlayers = await db.select().from(resultPlayers);
  const originalOutbox = await db.select().from(resultOutbox);
  await assert.rejects(overview('author', { instanceId }), /MODERATION_REQUIRED/);
  await db
    .insert(instanceGrants)
    .values({ instanceId, actorId: actors[2], permission: 'users' })
    .onConflictDoNothing();
  assert.equal((await overview('reviewer', { instanceId })).users.length, 4);
  await assert.rejects(
    overview('reviewer', { instanceId: otherId }),
    /MODERATION_REQUIRED/,
  );
  await assert.rejects(overview('reviewer', { instanceId: null }), /ADMIN_REQUIRED/);
  const operation = {
    instanceId,
    actorId: actors[1],
    operationId: crypto.randomUUID(),
    action: 'add',
    kind: 'timeout',
    restrictions: [],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    reason: '検証のため',
  };
  await mutate('reviewer', operation);
  await mutate('reviewer', operation);
  assert.equal(
    (
      await db
        .select()
        .from(moderationEvents)
        .where(eq(moderationEvents.id, operation.operationId))
    ).length,
    1,
  );
  await assert.rejects(
    mutate('reviewer', { ...operation, reason: '内容を変更' }),
    /OPERATION_CONFLICT/,
  );
  await assert.rejects(
    run((tx) =>
      requireUnrestricted(tx, input.organizationId, actors[1], instanceId, 'ranked'),
    ),
    /PARTICIPATION_RESTRICTED/,
  );
  await run((tx) =>
    requireUnrestricted(tx, input.organizationId, actors[1], otherId, 'ranked'),
  );
  await assert.rejects(
    run((tx) =>
      questionMutation(tx, 'author', instanceId, { operation: 'submit' }, 'local'),
    ),
    /PARTICIPATION_RESTRICTED/,
  );
  await assert.rejects(
    mutate('reviewer', {
      ...operation,
      operationId: crypto.randomUUID(),
      actorId: actors[0],
    }),
    /PROTECTED_ACCOUNT/,
  );
  await assert.rejects(
    mutate('admin', {
      ...operation,
      operationId: crypto.randomUUID(),
      actorId: actors[0],
    }),
    /PROTECTED_ACCOUNT/,
  );
  const partial = {
    ...operation,
    operationId: crypto.randomUUID(),
    kind: 'partial',
    restrictions: ['submit'],
    expiresAt: null,
  };
  await mutate('reviewer', partial);
  const change = {
    ...operation,
    action: 'change',
    id: operation.operationId,
    revision: 1,
    operationId: crypto.randomUUID(),
    reason: '変更の検証',
  };
  const race = await Promise.allSettled([
    mutate('reviewer', change),
    mutate('reviewer', { ...change, operationId: crypto.randomUUID(), reason: '競合' }),
  ]);
  assert.equal(race.filter((row) => row.status === 'fulfilled').length, 1);
  await mutate('reviewer', {
    ...operation,
    action: 'revoke',
    id: operation.operationId,
    revision: 2,
    operationId: crypto.randomUUID(),
    reason: '解除の検証',
  });
  await run((tx) =>
    requireUnrestricted(tx, input.organizationId, actors[1], instanceId, 'ranked'),
  );
  await assert.rejects(
    run((tx) =>
      requireUnrestricted(tx, input.organizationId, actors[1], instanceId, 'submit'),
    ),
    /PARTICIPATION_RESTRICTED/,
  );
  const global = {
    ...operation,
    instanceId: null,
    kind: 'ban',
    expiresAt: null,
    operationId: crypto.randomUUID(),
  };
  await mutate('admin', global);
  await assert.rejects(
    run((tx) =>
      requireUnrestricted(tx, input.organizationId, actors[1], otherId, 'ranked'),
    ),
    /PARTICIPATION_RESTRICTED/,
  );
  const inbox = await run((tx) => personalModeration(tx, 'author', {}));
  assert.equal(inbox.notifications.length, 5);
  await run((tx) =>
    personalModeration(tx, 'outsider', { readIds: [global.operationId] }),
  );
  assert.equal(
    (
      await db
        .select()
        .from(moderationEvents)
        .where(eq(moderationEvents.id, global.operationId))
    )[0].readAt,
    null,
  );
  await run((tx) => personalModeration(tx, 'author', { readIds: [global.operationId] }));
  assert.ok(
    (
      await db
        .select()
        .from(moderationEvents)
        .where(eq(moderationEvents.id, global.operationId))
    )[0].readAt,
  );
  await assert.rejects(
    run(async (tx) => {
      await tx
        .update(moderationEvents)
        .set({ reason: '改ざん' })
        .where(eq(moderationEvents.id, global.operationId));
    }),
  );
  const detail = await overview('reviewer', { instanceId, actorId: actors[1] });
  assert.ok(detail.events.some((row) => row.action === 'inspect'));
  await db.insert(moderationEvents).values(
    Array.from({ length: 105 }, (_, i) => ({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      instanceId,
      actorId: actors[1],
      operatorId: actors[0],
      action: 'inspect' as const,
      reason: `ページ検証${String(i).padStart(3, '0')}`,
      requestHash: '',
      createdAt: new Date(Date.now() - 1000000 + i * 1000).toISOString(),
    })),
  );
  const first = await overview('reviewer', {
    instanceId,
    actorId: actors[1],
    eventPageSize: 100,
  });
  assert.ok(first.eventsPagination && first.eventsPagination.total > 100);
  for (const eventSort of ['createdAt', 'action', 'operator', 'scope', 'reason']) {
    for (const eventDirection of ['asc', 'desc']) {
      const base = {
        instanceId,
        actorId: actors[1],
        eventsBefore: first.eventsBefore,
        eventSort,
        eventDirection,
      };
      const full = await overview('reviewer', { ...base, eventPageSize: 100 });
      const second = await overview('reviewer', {
        ...base,
        eventPage: 2,
        eventPageSize: 10,
      });
      assert.deepEqual(
        second.events.map((r) => r.id),
        full.events.slice(10, 20).map((r) => r.id),
      );
      assert.equal(second.eventsPagination?.total, first.eventsPagination.total);
    }
  }
  const tail = await overview('reviewer', {
    instanceId,
    actorId: actors[1],
    eventsBefore: first.eventsBefore,
    eventPageSize: 100,
    eventPage: 2,
  });
  assert.equal(first.events.length + tail.events.length, first.eventsPagination.total);
  assert.equal(
    new Set([...first.events, ...tail.events].map((r) => r.id)).size,
    first.eventsPagination.total,
  );
  assert.deepEqual(await db.select().from(questionSubmissions), original);
  assert.deepEqual(await db.select().from(matchResults), originalResults);
  assert.deepEqual(await db.select().from(resultPlayers), originalPlayers);
  assert.deepEqual(await db.select().from(resultOutbox), originalOutbox);
  assert.equal((await db.select().from(moderationSanctions)).length, 3);
  const bulk = (body: Record<string, unknown>) =>
    run((tx) => bulkSanctions(tx, 'reviewer', body));
  const snapshot = async (actorId: string) =>
    sanctionRevision(
      (await db.select().from(moderationSanctions)).filter((r) => r.actorId === actorId),
    );
  const batch = {
    instanceId,
    action: 'bulk',
    batchAction: 'add',
    kind: 'partial',
    restrictions: ['submit'],
    reason: '一括検証',
    expiresAt: null,
    organizationWide: false,
    operationId: crypto.randomUUID(),
    targets: [
      { actorId: actors[1], expected: await snapshot(actors[1]) },
      { actorId: actors[3], expected: await snapshot(actors[3]) },
    ],
  };
  const beforeBulk = await db.select().from(moderationSanctions);
  await assert.rejects(
    bulk({ ...batch, targets: [batch.targets[0], { actorId: actors[0], expected: '' }] }),
    /PROTECTED_ACCOUNT/,
  );
  assert.deepEqual(await db.select().from(moderationSanctions), beforeBulk);
  await bulk(batch);
  await bulk(batch);
  assert.equal(
    (await db.select().from(moderationSanctions)).length,
    beforeBulk.length + 2,
  );
  const revoke = {
    ...batch,
    batchAction: 'revoke',
    operationId: crypto.randomUUID(),
    targets: await Promise.all(
      batch.targets.map(async (t) => ({ ...t, expected: await snapshot(t.actorId) })),
    ),
  };
  await bulk(revoke);
  await bulk(revoke);
  await bulk({
    ...revoke,
    operationId: crypto.randomUUID(),
    targets: await Promise.all(
      batch.targets.map(async (t) => ({ ...t, expected: await snapshot(t.actorId) })),
    ),
  });
  console.log('PASS: bulk sanction protection rollback, replay and no-op revocation');
  console.log(
    'PASS: moderation roles, scope, protection, idempotency, concurrent edits, independent restrictions, private notifications and audit',
  );
}
