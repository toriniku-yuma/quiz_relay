import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it, vi } from 'vitest';
import { eraseInstance } from '../src/erasure/instances';
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
  instances,
  matches,
  organizationAccounts,
  organizationEvents,
  questionVersions,
  resultOutbox,
  resultPlayers,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import {
  addInstance,
  organizationIdentity,
  setInstanceGrants,
  setupOrganization,
} from '../src/worker/organization/database';
import { saveProfile } from '../src/worker/organization/profile';
import { recordWithdrawal, withdrawAccount } from '../src/worker/organization/withdrawal';
import { commitFixtureResult } from './fixtures/match';
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
async function deletion(instance: typeof instances.$inferSelect) {
  const { account } = await organizationIdentity(db, 'admin');
  const id = crypto.randomUUID();
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ state: 'archived' })
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
  const { record } = resultFixture();
  record.owner = instance.owner;
  record.result.finishedAt = Date.now();
  record.players[0].id = account.actorId;
  await commitFixtureResult(runtime.GAME_D1, record);
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
  const id = crypto.randomUUID();
  await recordWithdrawal(db, subject, id, 'local');
  expect(await eraseAuthentication(db, id, async () => {})).toBe(true);
  expect(await anonymizeWithdrawal(db, id)).toBe(true);
  const [pending] = await db
    .select()
    .from(accountWithdrawals)
    .where(eq(accountWithdrawals.id, id));
  expect(pending.auditErasedAt).not.toBeNull();
  expect(pending.erasedAt).not.toBeNull();
  expect(
    (
      await db.select().from(organizationEvents).where(eq(organizationEvents.id, eventId))
    )[0].details,
  ).toEqual({ action: 'grants', redacted: true });
  expect(await eraseResultNames(db)).toBe(0);
  expect(await anonymizeWithdrawal(db, id)).toBe(true);
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
});
it('削除は対象の原本だけを消し、他インスタンスと削除済みの証跡を保つ', async () => {
  const first = await target(),
    second = await target();
  for (const instance of [first.instance, second.instance]) {
    const { record } = resultFixture();
    record.owner = instance.owner;
    await commitFixtureResult(runtime.GAME_D1, record);
  }
  const id = await deletion(first.instance);
  expect(await eraseInstance(db, id)).toBe(false);
  const queries = vi.spyOn(db.$client, 'prepare');
  expect(await eraseInstance(db, id)).toBe(true);
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
  expect(await eraseInstance(db, id)).toBe(true);
});
it('復旧で退会と削除の証跡を再適用し、偽の証跡でDBを変更しない', async () => {
  const { subject, account, instance } = await target(),
    withdrawal = crypto.randomUUID();
  await recordWithdrawal(db, subject, withdrawal, 'local');
  const deletionId = await deletion(instance);
  await eraseInstance(db, deletionId);
  await eraseInstance(db, deletionId);
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
    )[0].deletedAt,
  ).not.toBeNull();
  await restorePrivacyJournal(db, journal);
});

it('退会受付後は待機枠を取り消してから非公開Workerで消去する', async () => {
  const { subject, account } = await target();
  const calls: string[] = [];
  const logoutActor = vi.fn(async () => {
    calls.push('cancel');
    return { ok: true };
  });
  const environment = {
    GAME_D1: runtime.GAME_D1,
    GAME_CONFIG_PROFILE: 'local',
    MATCHMAKER: { getByName: () => ({ logoutActor }) },
    ACCOUNT_ERASURE: {
      fetch: async () => {
        const [saved] = await db
          .select()
          .from(organizationAccounts)
          .where(eq(organizationAccounts.actorId, account.actorId));
        expect(saved.withdrawnAt).not.toBeNull();
        calls.push('erase');
        return Response.json({ ready: true });
      },
    },
  } as unknown as Env;
  await withdrawAccount(db, environment, subject, {
    operationId: crypto.randomUUID(),
    subject,
    confirmation: '退会',
  });
  expect(logoutActor).toHaveBeenCalledWith(account.actorId, []);
  expect(calls).toEqual(['cancel', 'erase']);
});
