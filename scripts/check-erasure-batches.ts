import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { expireRoomReviews } from '../src/erasure/index.ts';
import { eraseInstance } from '../src/erasure/instances.ts';
import { erasureBatch } from '../src/erasure/limits.ts';
import { anonymizeWithdrawal } from '../src/erasure/withdrawals.ts';
import {
  accountWithdrawals,
  instanceDeletions,
  instanceRooms,
  instances,
  organizationAccounts,
  organizations,
} from '../src/worker/db/schema.ts';
import type { Env } from '../src/worker/env.ts';
import { actorForSubject } from '../src/worker/organization/access.ts';

export async function verifyErasureBatches(db: PostgresJsDatabase) {
  const [organization] = await db.select().from(organizations).limit(1);
  const inventory = await db
    .select({ id: instances.id, complete: instances.roomInventoryComplete })
    .from(instances);
  // Earlier checks created no DOs; inventory gates must not hide the batch under test.
  await db.update(instances).set({ roomInventoryComplete: true });
  const organizationId = organization.id,
    instanceId = crypto.randomUUID(),
    subject = crypto.randomUUID();
  const namespace = organization.identityNamespace,
    owner = `urn:uuid:${instanceId}`;
  const actorId = await actorForSubject(namespace, subject),
    now = new Date().toISOString();
  await db.insert(instances).values({
    id: instanceId,
    organizationId,
    owner,
    name: '分割消去検証',
    state: 'archived',
    roomInventoryComplete: true,
  });
  await db
    .insert(organizationAccounts)
    .values({ organizationId, subject, actorId, withdrawnAt: now });
  const withdrawalId = crypto.randomUUID();
  await db
    .insert(accountWithdrawals)
    .values({ id: withdrawalId, organizationId, actorId, authDeletedAt: now });
  const ids = Array.from(
    { length: 1001 },
    (_, index) => `e${index.toString(16).padStart(63, '0')}`,
  );
  await db.insert(instanceRooms).values(ids.map((roomId) => ({ instanceId, roomId })));
  let calls = 0,
    safe = false,
    failAnonymization = true,
    failExpiry = true;
  const anonymous = new Set<string>(),
    checked = new Set<string>(),
    erased = new Set<string>(),
    reviewed = new Set<string>();
  const rooms = {
    idFromString: (id: string) => id,
    get: (id: string) => ({
      anonymizeAccount: async (actor: string) => {
        assert.equal(actor, actorId);
        calls++;
        if (failAnonymization && id === ids[20]) {
          failAnonymization = false;
          throw new Error('ROOM_UNAVAILABLE');
        }
        anonymous.add(id);
      },
      expireReview: async () => {
        calls++;
        if (failExpiry && id === ids[0]) {
          failExpiry = false;
          throw new Error('ROOM_UNAVAILABLE');
        }
        reviewed.add(id);
      },
      deletionStatus: async () => {
        calls++;
        checked.add(id);
        return { safe: safe || id !== ids[1000] };
      },
      eraseInstance: async () => {
        calls++;
        assert.equal(checked.size, 1001);
        erased.add(id);
        return { ok: true };
      },
    }),
  } as unknown as Env['GAME_ROOM'];
  const matchmaker = {
    beginWithdrawal: async () => ({ ok: true }),
    logoutActor: async () => {},
    anonymizeAccount: async () => {},
  };
  const env = {
    GAME_ROOM: rooms,
    MATCHMAKER: { getByName: () => matchmaker },
  } as unknown as Pick<Env, 'GAME_ROOM' | 'MATCHMAKER'>;
  const privacy = <T>(
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_erasure`);
      return fn(tx);
    });
  await assert.rejects(
    privacy((tx) => anonymizeWithdrawal(tx, env, withdrawalId)),
    /ROOM_UNAVAILABLE/,
  );
  assert.equal(
    (
      await db
        .select()
        .from(accountWithdrawals)
        .where(eq(accountWithdrawals.id, withdrawalId))
    )[0].roomCursor,
    null,
  );
  let finished = false;
  for (let index = 0; !finished && index < 50; index++) {
    calls = 0;
    finished = await privacy((tx) => anonymizeWithdrawal(tx, env, withdrawalId));
    assert.ok(calls <= erasureBatch.rooms);
  }
  assert.ok(finished);
  assert.equal(anonymous.size, 1001);
  assert.ok(
    (
      await db
        .select()
        .from(accountWithdrawals)
        .where(eq(accountWithdrawals.id, withdrawalId))
    )[0].erasedAt,
  );
  let expiryFailed = false;
  await privacy(async (tx) => {
    try {
      await expireRoomReviews(tx, rooms);
    } catch (error) {
      assert.match(String(error), /REVIEW_EXPIRY_INCOMPLETE/);
      expiryFailed = true;
    }
  });
  assert.ok(expiryFailed);
  assert.notEqual(
    (await db.select().from(instanceRooms).where(eq(instanceRooms.roomId, ids[0])))[0]
      .reviewAttemptedAt,
    '1970-01-01 00:00:00+00',
  );
  for (let index = 0; reviewed.size < 1001 && index < 50; index++) {
    calls = 0;
    await privacy((tx) => expireRoomReviews(tx, rooms));
    assert.ok(calls <= erasureBatch.rooms);
  }
  assert.equal(reviewed.size, 1001);
  const deletionId = crypto.randomUUID();
  const receipt = {
    id: deletionId,
    instanceId,
    organizationId,
    owner,
    name: '分割消去検証',
    operatorId: actorId,
  };
  await db.insert(instanceDeletions).values(receipt);
  const erase = async () => {
    let blocked: Error | undefined;
    const ready = await privacy(async (tx) => {
      try {
        return await eraseInstance(tx, rooms, deletionId);
      } catch (error) {
        if (error instanceof Error && error.message === 'RESULT_OR_MATCH_PENDING') {
          blocked = error;
          return false;
        }
        throw error;
      }
    });
    if (blocked) throw blocked;
    return ready;
  };
  let rejected = false;
  for (let index = 0; !rejected && index < 50; index++) {
    calls = 0;
    try {
      assert.equal(await erase(), false);
    } catch (error) {
      assert.match(String(error), /RESULT_OR_MATCH_PENDING/);
      rejected = true;
    }
    assert.ok(calls <= erasureBatch.rooms);
    assert.equal(erased.size, 0);
  }
  assert.ok(rejected);
  assert.equal(
    (
      await db
        .select()
        .from(instanceDeletions)
        .where(eq(instanceDeletions.id, deletionId))
    ).length,
    0,
  );
  safe = true;
  checked.clear();
  await db.insert(instanceDeletions).values(receipt);
  finished = false;
  for (let index = 0; !finished && index < 100; index++) {
    calls = 0;
    finished = await erase();
    assert.ok(calls <= 2 * erasureBatch.rooms);
  }
  assert.ok(finished);
  assert.equal(erased.size, 1001);
  assert.equal(
    (await db.select().from(instances).where(eq(instances.id, instanceId))).length,
    0,
  );
  assert.equal(await erase(), true);
  for (const scope of inventory)
    await db
      .update(instances)
      .set({ roomInventoryComplete: scope.complete })
      .where(eq(instances.id, scope.id));
  console.log(
    'PASS: 1001-room bounded anonymization/expiry/deletion, persisted retry progress and no erase before all safety checks',
  );
}
