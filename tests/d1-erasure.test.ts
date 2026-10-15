import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it, vi } from 'vitest';
import { eraseInstance } from '../src/erasure/instances';
import { reconcileRoomInventory } from '../src/erasure/inventory';
import { eraseAuthentication } from '../src/erasure/jobs';
import { exportPrivacyJournal, restorePrivacyJournal } from '../src/erasure/recovery';
import { eraseResultNames } from '../src/erasure/results';
import { anonymizeWithdrawal } from '../src/erasure/withdrawals';
import { changeD1, connectD1 } from '../src/worker/db/d1';
import {
  accountWithdrawals,
  databaseRevision,
  instanceDeletions,
  instanceGrants,
  instanceRooms,
  instances,
  matches,
  organizationAccounts,
  organizationEvents,
  questionVersions,
  resultOutbox,
  resultPlayers,
  roomInventoryScans,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import {
  addInstance,
  organizationIdentity,
  setInstanceGrants,
  setupOrganization,
} from '../src/worker/organization/database';
import { saveProfile } from '../src/worker/organization/profile';
import { recordWithdrawal } from '../src/worker/organization/withdrawal';
import { commitD1Result } from '../src/worker/results/database';
import { questions } from './fixtures/questions';
import { resultFixture } from './fixtures/result';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '消去検証',
    instanceName: '初期対象',
  });
});
async function target() {
  const id = crypto.randomUUID(),
    subject = crypto.randomUUID();
  await addInstance(db, 'admin', { id, name: `対象${id.slice(0, 8)}` });
  const { account, organization } = await organizationIdentity(db, subject);
  await saveProfile(
    db,
    subject,
    { displayName: `対象者${id.slice(0, 8)}`, revision: 0 },
    'local',
  );
  await setInstanceGrants(db, 'admin', {
    id,
    actorId: account.actorId,
    expected: '',
    permissions: ['questions'],
  });
  const [instance] = await db.select().from(instances).where(eq(instances.id, id));
  return { instance, subject, account, organization };
}
function services(safe = true) {
  const room = {
    deletionStatus: vi.fn(async () => ({ safe })),
    eraseInstance: vi.fn(async () => ({ ok: true })),
    eraseRestoredInstance: vi.fn(async () => {}),
    anonymizeAccount: vi.fn(async () => {}),
    inventoryScope: vi.fn(
      async () => null as { owner: string; instanceId?: string } | null,
    ),
    registerInventory: vi.fn(async () => {}),
  };
  const matchmaker = {
    beginWithdrawal: vi.fn(async () => ({ ok: true })),
    logoutActor: vi.fn(async () => {}),
    anonymizeAccount: vi.fn(async () => {}),
  };
  const environment = {
    GAME_ROOM: { get: () => room, idFromString: (id: string) => id },
    MATCHMAKER: { getByName: () => matchmaker },
  } as unknown as Pick<Env, 'GAME_ROOM' | 'MATCHMAKER'>;
  return { room, matchmaker, environment };
}
async function deletion(instance: typeof instances.$inferSelect) {
  const { account } = await organizationIdentity(db, 'admin');
  const id = crypto.randomUUID();
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ state: 'archived', roomInventoryComplete: true })
        .where(eq(instances.id, instance.id)),
      db.insert(instanceDeletions).values({
        id,
        instanceId: instance.id,
        organizationId: instance.organizationId,
        owner: instance.owner,
        name: instance.name,
        operatorId: account.actorId,
      }),
    );
  });
  return id;
}
it('最後の管理者の退会を拒否し、本人の退会受付は権限取消と匿名化を一度だけ保存する', async () => {
  await expect(
    recordWithdrawal(db, 'admin', crypto.randomUUID(), 'local'),
  ).rejects.toThrow('LAST_ADMINISTRATOR');
  const { subject, account } = await target();
  const id = crypto.randomUUID();
  const job = await recordWithdrawal(db, subject, id, 'local');
  expect(
    (
      await db
        .select()
        .from(organizationAccounts)
        .where(eq(organizationAccounts.actorId, account.actorId))
    )[0],
  ).toMatchObject({
    displayName: null,
    administrator: false,
    withdrawnAt: job.requestedAt,
  });
  expect(
    await db
      .select()
      .from(instanceGrants)
      .where(eq(instanceGrants.actorId, account.actorId)),
  ).toEqual([]);
  const [revision] = await db.select().from(databaseRevision);
  expect(await recordWithdrawal(db, subject, id, 'local')).toEqual(job);
  expect((await db.select().from(databaseRevision))[0].revision).toBe(revision.revision);
  await expect(
    recordWithdrawal(db, subject, crypto.randomUUID(), 'local'),
  ).rejects.toThrow('ACCOUNT_WITHDRAWN');
});
it('認証削除の失敗と同時呼出しを保存し、期限後だけ再試行する', async () => {
  const { subject } = await target(),
    id = crypto.randomUUID();
  await recordWithdrawal(db, subject, id, 'local');
  const remove = vi.fn(async () => {
    throw new Error('isolated failure');
  });
  expect(await eraseAuthentication(db, id, remove)).toBe(false);
  expect(await eraseAuthentication(db, id, remove)).toBe(false);
  expect(remove).toHaveBeenCalledTimes(1);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(accountWithdrawals)
        .set({ retryAt: '1970-01-01T00:00:00.000Z' })
        .where(eq(accountWithdrawals.id, id)),
    );
  });
  let releaseDeletion!: () => void;
  const deletion = new Promise<void>((resolve) => {
    releaseDeletion = resolve;
  });
  const success = vi.fn(() => deletion);
  const concurrent = [
    eraseAuthentication(db, id, success),
    eraseAuthentication(db, id, success),
  ];
  try {
    // Keep the winning provider request pending until the competing lease is rejected.
    expect(await Promise.race(concurrent)).toBe(false);
    expect(success).toHaveBeenCalledTimes(1);
  } finally {
    releaseDeletion();
    await Promise.all(concurrent);
  }
  expect((await Promise.all(concurrent)).sort()).toEqual([false, true]);
  expect(success).toHaveBeenCalledTimes(1);
  expect(await eraseAuthentication(db, id, success)).toBe(true);
  expect(success).toHaveBeenCalledTimes(1);
});
it('結果原本・outbox・参加者を匿名化してから退会を完了し、監査の再匿名化を繰り返さない', async () => {
  const { subject, account, instance } = await target();
  await changeD1(db, async (writes) => {
    writes.push(db.update(instances).set({ roomInventoryComplete: true }));
  });
  const { record } = resultFixture();
  record.owner = instance.owner;
  record.result.finishedAt = Date.now();
  record.players[0].id = account.actorId;
  await commitD1Result(runtime.GAME_D1, record);
  const eventId = crypto.randomUUID();
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(organizationEvents).values({
        id: eventId,
        actorId: account.actorId,
        action: 'grants',
        instanceId: instance.id,
        details: { action: 'grants', secret: '消す自由記述' },
      }),
    );
  });
  const id = crypto.randomUUID(),
    { environment, matchmaker } = services();
  await recordWithdrawal(db, subject, id, 'local');
  expect(await eraseAuthentication(db, id, async () => {})).toBe(true);
  expect(await anonymizeWithdrawal(db, environment, id)).toBe(false);
  const [pending] = await db
    .select()
    .from(accountWithdrawals)
    .where(eq(accountWithdrawals.id, id));
  expect(pending.auditErasedAt).not.toBeNull();
  expect(pending.erasedAt).toBeNull();
  expect(
    (
      await db.select().from(organizationEvents).where(eq(organizationEvents.id, eventId))
    )[0].details,
  ).toEqual({ action: 'grants', redacted: true });
  expect(await eraseResultNames(db)).toBe(1);
  expect(await anonymizeWithdrawal(db, environment, id)).toBe(true);
  expect(
    (await db.select().from(accountWithdrawals).where(eq(accountWithdrawals.id, id)))[0]
      .auditErasedAt,
  ).toBe(pending.auditErasedAt);
  expect(
    (
      await db.select().from(resultOutbox).where(eq(resultOutbox.matchId, record.matchId))
    )[0].payload.players[0].name,
  ).toBe('退会ユーザー');
  expect(
    (
      await db
        .select()
        .from(resultPlayers)
        .where(eq(resultPlayers.matchId, record.matchId))
    ).find((player) => player.actorId === account.actorId)?.name,
  ).toBe('退会ユーザー');
  expect(matchmaker.anonymizeAccount).toHaveBeenCalled();
});
it('未確定の試合があるインスタンスを削除せず、受付を取り消す', async () => {
  const { instance } = await target(),
    id = await deletion(instance),
    { room, environment } = services(false);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .insert(instanceRooms)
        .values({ roomId: '1'.repeat(64), instanceId: instance.id }),
    );
  });
  await expect(eraseInstance(db, environment.GAME_ROOM, id)).rejects.toThrow(
    'RESULT_OR_MATCH_PENDING',
  );
  expect(room.eraseInstance).not.toHaveBeenCalled();
  expect(
    await db.select().from(instanceDeletions).where(eq(instanceDeletions.id, id)),
  ).toEqual([]);
  expect(
    await db.select().from(instances).where(eq(instances.id, instance.id)),
  ).toHaveLength(1);
});
it('削除は対象の原本だけを消し、他インスタンスと削除済みの証跡を保つ', async () => {
  const first = await target(),
    second = await target();
  for (const instance of [first.instance, second.instance]) {
    const { record } = resultFixture();
    record.owner = instance.owner;
    await commitD1Result(runtime.GAME_D1, record);
  }
  const id = await deletion(first.instance),
    { environment } = services();
  expect(await eraseInstance(db, environment.GAME_ROOM, id)).toBe(false);
  const queries = vi.spyOn(db.$client, 'prepare');
  expect(await eraseInstance(db, environment.GAME_ROOM, id)).toBe(true);
  expect(queries.mock.calls.length).toBeLessThanOrEqual(50);
  queries.mockRestore();
  expect(
    await db.select().from(matches).where(eq(matches.owner, first.instance.owner)),
  ).toEqual([]);
  expect(
    await db.select().from(matches).where(eq(matches.owner, second.instance.owner)),
  ).toHaveLength(1);
  const [receipt] = await db
    .select()
    .from(instanceDeletions)
    .where(eq(instanceDeletions.id, id));
  expect(receipt.deletedAt).not.toBeNull();
  await expect(
    changeD1(db, async (writes) => {
      writes.push(db.insert(instances).values(first.instance));
    }),
  ).rejects.toThrow('INSTANCE_DELETION_RECORDED');
  await expect(
    changeD1(db, async (writes) => {
      writes.push(
        db.insert(questionVersions).values({
          owner: first.instance.owner,
          questionId: crypto.randomUUID(),
          version: 1,
          payload: {
            ...questions[0],
            version: 1,
            distractors: [],
            source: '検証',
            permission: 'instance',
            demoAllowed: true,
          },
        }),
      );
    }),
  ).rejects.toThrow('INSTANCE_DELETION_RECORDED');
  expect(await eraseInstance(db, environment.GAME_ROOM, id)).toBe(true);
});
it('DO削除失敗で原本を保ち、同じ受付から再開する', async () => {
  const { instance } = await target(),
    id = await deletion(instance),
    { room, environment } = services();
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .insert(instanceRooms)
        .values({ roomId: '2'.repeat(64), instanceId: instance.id }),
    );
  });
  room.eraseInstance.mockRejectedValueOnce(new Error('isolated unavailable'));
  expect(await eraseInstance(db, environment.GAME_ROOM, id)).toBe(false);
  await expect(eraseInstance(db, environment.GAME_ROOM, id)).rejects.toThrow(
    'isolated unavailable',
  );
  expect(
    await db.select().from(instances).where(eq(instances.id, instance.id)),
  ).toHaveLength(1);
  expect(
    (await db.select().from(instanceDeletions).where(eq(instanceDeletions.id, id)))[0]
      .roomCursor,
  ).toBeNull();
  expect(await eraseInstance(db, environment.GAME_ROOM, id)).toBe(true);
});
it('部屋一覧の確認は停止中だけ進め、失敗したページを確定しない', async () => {
  const { instance } = await target(),
    { room, environment } = services();
  room.inventoryScope.mockResolvedValue({
    owner: instance.owner,
    instanceId: instance.id,
  });
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ roomInventoryComplete: false })
        .where(eq(instances.id, instance.id)),
    );
  });
  const inventory = {
    ...environment,
    LOCAL_ROOM_INVENTORY: JSON.stringify(['3'.repeat(64)]),
  };
  room.registerInventory.mockRejectedValueOnce(new Error('isolated unavailable'));
  await expect(reconcileRoomInventory(db, inventory)).rejects.toThrow(
    'isolated unavailable',
  );
  expect((await db.select().from(roomInventoryScans))[0].complete).toBe(false);
  expect(await reconcileRoomInventory(db, inventory)).toBe(true);
  expect(
    (await db.select().from(instances).where(eq(instances.id, instance.id)))[0]
      .roomInventoryComplete,
  ).toBe(true);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ state: 'published', roomInventoryComplete: false })
        .where(eq(instances.id, instance.id)),
    );
  });
  await expect(reconcileRoomInventory(db, inventory)).rejects.toThrow(
    'INVENTORY_REQUIRES_PAUSE',
  );
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ state: 'preparing', roomInventoryComplete: true })
        .where(eq(instances.id, instance.id)),
    );
  });
});
it('復旧で退会と削除の証跡を再適用し、偽の証跡でDBを変更しない', async () => {
  const { subject, account, instance } = await target(),
    withdrawal = crypto.randomUUID();
  await recordWithdrawal(db, subject, withdrawal, 'local');
  const deletionId = await deletion(instance),
    { environment } = services();
  await eraseInstance(db, environment.GAME_ROOM, deletionId);
  await eraseInstance(db, environment.GAME_ROOM, deletionId);
  const journal = await exportPrivacyJournal(db);
  const tampered = structuredClone(journal);
  tampered.withdrawals[0].subject = 'wrong';
  const [before] = await db.select().from(databaseRevision);
  await expect(restorePrivacyJournal(db, tampered)).rejects.toThrow(
    'INVALID_WITHDRAWAL_RECEIPT',
  );
  expect((await db.select().from(databaseRevision))[0].revision).toBe(before.revision);
  await restorePrivacyJournal(db, journal);
  expect(
    (
      await db
        .select()
        .from(organizationAccounts)
        .where(eq(organizationAccounts.actorId, account.actorId))
    )[0].withdrawnAt,
  ).not.toBeNull();
  expect(
    (
      await db
        .select()
        .from(accountWithdrawals)
        .where(eq(accountWithdrawals.id, withdrawal))
    )[0],
  ).toMatchObject({ authDeletedAt: null, erasedAt: null, auditErasedAt: null });
  expect(
    (
      await db
        .select()
        .from(instanceDeletions)
        .where(eq(instanceDeletions.id, deletionId))
    )[0].inventoryPending,
  ).toBe(true);
  await restorePrivacyJournal(db, journal);
});
