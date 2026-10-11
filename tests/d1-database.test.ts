import { applyD1Migrations, env } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { changeD1, connectD1, rowsD1 } from '../src/worker/db/d1';
import {
  databaseRevision,
  instanceGrants,
  instances,
  moderationRequests,
  organizationAccounts,
  organizationEvents,
  organizations,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import {
  addInstance,
  changeInstanceOperation,
  organizationIdentity,
  overview,
  renameInstance,
  setInstanceGrants,
  setInstanceSelection,
  setupOrganization,
} from '../src/worker/organization/database';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: 'D1検証',
    instanceName: '初期対象',
  });
});
let playerSubject: string, instanceId: string;
beforeEach(async () => {
  playerSubject = crypto.randomUUID();
  instanceId = crypto.randomUUID();
  await addInstance(db, 'admin', { id: instanceId, name: '最初のインスタンス' });
  const user = await organizationIdentity(db, playerSubject);
  const [instance] = await db
    .select()
    .from(instances)
    .where(eq(instances.id, instanceId));
  await setInstanceGrants(db, 'admin', {
    id: instance.id,
    actorId: user.account.actorId,
    expected: '',
    permissions: ['questions'],
  });
});

it('D1だけで初期管理者・インスタンス・アカウント・お気に入り・権限・名称を保存する', async () => {
  const initial = await overview(db, 'admin');
  expect(initial.account?.administrator).toBe(true);
  const id = crypto.randomUUID();
  await addInstance(db, 'admin', { id, name: '追加先' });
  await setInstanceSelection(db, 'admin', { id, added: true });
  expect((await overview(db, 'admin')).addedInstanceIds).toContain(id);
  const user = await organizationIdentity(db, playerSubject);
  await setInstanceGrants(db, 'admin', {
    id,
    actorId: user.account.actorId,
    expected: '',
    permissions: ['questions'],
  });
  expect(
    (await overview(db, playerSubject)).instances.find((row) => row.id === id)
      ?.permissions,
  ).toEqual(['questions']);
  await renameInstance(db, 'admin', { id, expectedName: '追加先', name: '変更済み' });
  await expect(
    renameInstance(db, 'admin', { id, expectedName: '追加先', name: '上書き' }),
  ).rejects.toThrow('EDIT_CONFLICT');
  expect((await db.select().from(instances).where(eq(instances.id, id)))[0].name).toBe(
    '変更済み',
  );
  await expect(
    setInstanceGrants(db, playerSubject, {
      id,
      actorId: user.account.actorId,
      expected: 'questions',
      permissions: ['users'],
    }),
  ).rejects.toThrow('ADMIN_REQUIRED');
});

it('一括書込みの途中失敗では変更と更新世代を一緒に巻き戻す', async () => {
  const [before] = await db.select().from(databaseRevision);
  const id = crypto.randomUUID();
  await expect(
    changeD1(db, async (writes) => {
      writes.push(
        db.insert(organizationEvents).values({
          id,
          actorId: 'a'.repeat(64),
          action: 'add',
          instanceId: null,
          details: {},
        }),
        sql`insert into missing_table (id) values ('failure')`,
      );
    }),
  ).rejects.toThrow();
  expect(
    await db.select().from(organizationEvents).where(eq(organizationEvents.id, id)),
  ).toEqual([]);
  expect((await db.select().from(databaseRevision))[0].revision).toBe(before.revision);
});

it('同時更新は古い読取りを検出して計画からやり直す', async () => {
  let arrived = 0,
    release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const [organization] = await db.select().from(organizations);
  const update = () =>
    changeD1(db, async (writes) => {
      const [current] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, organization.id));
      reads++;
      if (++arrived <= 2) {
        if (arrived === 2) release();
        await barrier;
      }
      writes.push(
        db
          .update(organizations)
          .set({ name: `${current.name}追記` })
          .where(eq(organizations.id, current.id)),
      );
    });
  await Promise.all([update(), update()]);
  expect((await db.select().from(organizations))[0].name).toBe('D1検証追記追記');
  expect(reads).toBe(3);
});

it('退会済みのアカウントはお気に入りと権限の更新に使えない', async () => {
  const user = await organizationIdentity(db, playerSubject);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(organizationAccounts)
        .set({ withdrawnAt: new Date().toISOString() })
        .where(eq(organizationAccounts.actorId, user.account.actorId)),
    );
  });
  const [instance] = await db
    .select()
    .from(instances)
    .where(eq(instances.id, instanceId));
  await expect(
    setInstanceSelection(db, playerSubject, { id: instance.id, added: false }),
  ).rejects.toThrow('ACCOUNT_WITHDRAWN');
  await expect(
    setInstanceGrants(db, 'admin', {
      id: instance.id,
      actorId: user.account.actorId,
      expected: '',
      permissions: [],
    }),
  ).rejects.toThrow('ACCOUNT_WITHDRAWN');
  expect(
    (
      await db
        .select()
        .from(instanceGrants)
        .where(eq(instanceGrants.instanceId, instanceId))
    ).length,
  ).toBe(1);
});

it('500行の取込みを1つのSQLへまとめ、JSONと既定値を維持する', async () => {
  const rows = Array.from({ length: 500 }, (_, index) => ({
    id: crypto.randomUUID(),
    actorId: 'b'.repeat(64),
    action: 'add' as const,
    details: { label: `日本語${index}`, flags: [true, false], value: null },
  }));
  await changeD1(db, async (writes) => {
    writes.push(rowsD1(organizationEvents, rows));
  });
  const saved = await db
    .select()
    .from(organizationEvents)
    .where(eq(organizationEvents.actorId, 'b'.repeat(64)));
  expect(saved).toHaveLength(500);
  expect(saved[0].instanceId).toBe(null);
  expect(saved.find((row) => row.id === rows[499].id)?.details).toEqual(
    rows[499].details,
  );
});

it('公開・停止・保管・復元と受付記録を同時保存し、再送や古い更新を拒否する', async () => {
  const [initial] = await db.select().from(instances).where(eq(instances.id, instanceId));
  let current = initial;
  for (const action of [
    'publish',
    'stopRanked',
    'resumeRanked',
    'stopCasual',
    'resumeCasual',
    'prepare',
    'archive',
    'restore',
  ]) {
    const operation = {
      id: initial.id,
      operationId: crypto.randomUUID(),
      revision: current.operationRevision,
      action,
      reason: '検証中',
    };
    await changeInstanceOperation(db, 'admin', operation);
    await changeInstanceOperation(db, 'admin', operation);
    [current] = await db.select().from(instances).where(eq(instances.id, initial.id));
    expect(current.operationRevision).toBe(operation.revision + 1);
    const records = await db
      .select()
      .from(moderationRequests)
      .where(eq(moderationRequests.id, operation.operationId));
    expect(records).toHaveLength(1);
    await expect(
      changeInstanceOperation(db, 'admin', { ...operation, reason: '違う要求' }),
    ).rejects.toThrow('OPERATION_CONFLICT');
    await expect(
      changeInstanceOperation(db, 'admin', {
        ...operation,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow('EDIT_CONFLICT');
  }
  expect(current.state).toBe('preparing');
  expect(current.rankedPauseReason).toBe(null);
  expect(current.casualPauseReason).toBe(null);
  await expect(
    changeInstanceOperation(db, playerSubject, {
      id: initial.id,
      operationId: crypto.randomUUID(),
      revision: current.operationRevision,
      action: 'publish',
    }),
  ).rejects.toThrow('ADMIN_REQUIRED');
});
