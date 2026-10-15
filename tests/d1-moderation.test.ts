import { applyD1Migrations, env } from 'cloudflare:test';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { sanctionRevision } from '../src/shared/moderation';
import { changeD1, connectD1, rowsD1 } from '../src/worker/db/d1';
import {
  administratorTransfers,
  databaseRevision,
  federationActors,
  federationPeers,
  instances,
  moderationEvents,
  moderationRequests,
  moderationSanctions,
  organizationAccounts,
  sanctionAppeals,
  userReports,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { bulkSanctions } from '../src/worker/organization/bulk';
import {
  addInstance,
  organizationIdentity,
  setInstanceGrants,
  setupOrganization,
} from '../src/worker/organization/database';
import {
  actorSanctions,
  moderationOverview,
  mutateSanction,
  personalModeration,
  rankingExclusions,
  requireUnrestricted,
} from '../src/worker/organization/moderation';
import { moderationWorkflow } from '../src/worker/organization/workflow';
import type { ResultRecord } from '../src/worker/results/record';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
let organizationId: string,
  instanceId: string,
  otherInstanceId: string,
  actorId: string,
  adminId: string;
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(
    db,
    { INITIAL_ADMIN_SUBJECT: 'installer' } as Env,
    'installer',
    { name: '運営検証', instanceName: '初期対象' },
  );
});
let adminSubject: string, playerSubject: string, moderatorSubject: string;
beforeEach(async () => {
  adminSubject = crypto.randomUUID();
  playerSubject = crypto.randomUUID();
  moderatorSubject = crypto.randomUUID();
  const adminAccount = await organizationIdentity(db, adminSubject);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(organizationAccounts)
        .set({ administrator: true })
        .where(eq(organizationAccounts.actorId, adminAccount.account.actorId)),
    );
  });
  const admin = await organizationIdentity(db, adminSubject);
  organizationId = admin.organization.id;
  adminId = admin.account.actorId;
  actorId = (await organizationIdentity(db, playerSubject)).account.actorId;
  const moderator = await organizationIdentity(db, moderatorSubject);
  instanceId = crypto.randomUUID();
  await addInstance(db, adminSubject, { id: instanceId, name: '対象' });
  otherInstanceId = crypto.randomUUID();
  await addInstance(db, adminSubject, { id: otherInstanceId, name: '別対象' });
  await setInstanceGrants(db, adminSubject, {
    id: instanceId,
    actorId: moderator.account.actorId,
    expected: '',
    permissions: ['users'],
  });
});
const ban = (extra: Record<string, unknown> = {}) => ({
  instanceId,
  actorId,
  operationId: crypto.randomUUID(),
  action: 'add',
  kind: 'ban',
  restrictions: [],
  expiresAt: null,
  reason: '規約違反',
  ...extra,
});
const workflow = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  operationId: crypto.randomUUID(),
  ...extra,
});

it('処分の再送・競合・BAN取消を原本と監査記録へ一緒に保存する', async () => {
  const input = ban();
  await mutateSanction(db, moderatorSubject, input);
  await mutateSanction(db, moderatorSubject, input);
  expect(
    await db
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.instanceId, instanceId)),
  ).toHaveLength(1);
  await expect(
    mutateSanction(db, moderatorSubject, { ...input, reason: '異なる要求' }),
  ).rejects.toThrow('OPERATION_CONFLICT');
  await expect(
    requireUnrestricted(db, organizationId, actorId, instanceId, 'ranked'),
  ).rejects.toThrow('PARTICIPATION_RESTRICTED');
  await requireUnrestricted(db, organizationId, actorId, otherInstanceId, 'ranked');
  const [before] = await actorSanctions(db, organizationId, actorId);
  await expect(
    mutateSanction(
      db,
      adminSubject,
      ban({
        action: 'change',
        id: before.id,
        revision: before.revision,
        kind: 'partial',
        restrictions: ['ranked'],
      }),
    ),
  ).rejects.toThrow('BAN_REQUIRES_REVOKE');
  await mutateSanction(
    db,
    moderatorSubject,
    ban({ action: 'revoke', id: before.id, revision: before.revision }),
  );
  await requireUnrestricted(db, organizationId, actorId, instanceId, 'ranked');
  expect(await rankingExclusions(db, organizationId, instanceId)).not.toContain(actorId);
  expect((await actorSanctions(db, organizationId, actorId))[0].revision).toBe(2);
});

it('対象外インスタンス・組織処分・管理担当者・本人・退会者への権限越えを拒否する', async () => {
  await expect(
    mutateSanction(db, moderatorSubject, ban({ instanceId: otherInstanceId })),
  ).rejects.toThrow('MODERATION_REQUIRED');
  await expect(
    mutateSanction(db, moderatorSubject, ban({ organizationWide: true })),
  ).rejects.toThrow('ADMIN_REQUIRED');
  await expect(
    mutateSanction(db, moderatorSubject, ban({ actorId: adminId })),
  ).rejects.toThrow('PROTECTED_ACCOUNT');
  await expect(mutateSanction(db, playerSubject, ban())).rejects.toThrow(
    'MODERATION_REQUIRED',
  );
  await expect(
    mutateSanction(db, adminSubject, ban({ actorId: adminId })),
  ).rejects.toThrow('PROTECTED_ACCOUNT');
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(organizationAccounts)
        .set({ withdrawnAt: new Date().toISOString() })
        .where(eq(organizationAccounts.actorId, actorId)),
    );
  });
  await expect(mutateSanction(db, adminSubject, ban())).rejects.toThrow(
    'ACCOUNT_WITHDRAWN',
  );
  expect(
    await db
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.instanceId, instanceId)),
  ).toHaveLength(0);
});

it('同じ版への並行編集は一方だけを確定し、失敗した編集の監査を残さない', async () => {
  await mutateSanction(db, adminSubject, ban());
  const [before] = await actorSanctions(db, organizationId, actorId);
  const input = ban({ action: 'change', id: before.id, revision: before.revision });
  const results = await Promise.allSettled([
    mutateSanction(db, adminSubject, input),
    mutateSanction(db, adminSubject, {
      ...input,
      operationId: crypto.randomUUID(),
      reason: '別編集',
    }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(
    await db
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.instanceId, instanceId)),
  ).toHaveLength(2);
  expect((await actorSanctions(db, organizationId, actorId))[0].revision).toBe(2);
});

it('500人一括処分・再送・取消をD1の引数上限内で保存し、末尾の競合では全件を維持する', async () => {
  const accounts = Array.from({ length: 500 }, (_, index) => ({
    organizationId,
    subject: `bulk-${index}`,
    actorId: index.toString(16).padStart(64, '0'),
    displayName: `対象${index}`,
  }));
  await changeD1(db, async (writes) => {
    writes.push(rowsD1(organizationAccounts, accounts));
  });
  const input = ban({
    batchAction: 'add',
    targets: accounts.map((account) => ({ actorId: account.actorId, expected: '' })),
  });
  await bulkSanctions(db, adminSubject, input);
  await bulkSanctions(db, adminSubject, input);
  expect(
    await db
      .select()
      .from(moderationSanctions)
      .where(eq(moderationSanctions.instanceId, instanceId)),
  ).toHaveLength(500);
  expect(
    await db
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.instanceId, instanceId)),
  ).toHaveLength(500);
  const current = await db
    .select()
    .from(moderationSanctions)
    .where(eq(moderationSanctions.instanceId, instanceId));
  const targets = accounts.map((account) => ({
    actorId: account.actorId,
    expected: sanctionRevision(current.filter((row) => row.actorId === account.actorId)),
  }));
  const invalid = targets.map((target, index) =>
    index === 499 ? { ...target, expected: '古い版' } : target,
  );
  const [before] = await db.select().from(databaseRevision);
  await expect(
    bulkSanctions(db, adminSubject, {
      ...input,
      operationId: crypto.randomUUID(),
      batchAction: 'revoke',
      targets: invalid,
    }),
  ).rejects.toThrow('EDIT_CONFLICT');
  expect((await db.select().from(databaseRevision))[0].revision).toBe(before.revision);
  expect(
    await db
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.instanceId, instanceId)),
  ).toHaveLength(500);
  await bulkSanctions(db, adminSubject, {
    ...input,
    operationId: crypto.randomUUID(),
    batchAction: 'revoke',
    targets,
  });
  expect(
    (
      await db
        .select()
        .from(moderationSanctions)
        .where(eq(moderationSanctions.instanceId, instanceId))
    ).every((row) => row.revokedAt),
  ).toBe(true);
});

it('一覧の検索・100件ページ・並べ替えと調査閲覧の監査をD1で実行する', async () => {
  const accounts = Array.from({ length: 101 }, (_, index) => ({
    organizationId,
    subject: `page-${index}`,
    actorId: (index + 1000).toString(16).padStart(64, '0'),
    displayName: `100%_${index}`,
  }));
  await changeD1(db, async (writes) => {
    writes.push(rowsD1(organizationAccounts, accounts));
  });
  const page = await moderationOverview(db, moderatorSubject, {
    instanceId,
    query: '100%_',
    pageSize: 100,
    sort: 'name',
  });
  expect(page.users).toHaveLength(100);
  expect(page.pagination?.total).toBe(101);
  const detail = await moderationOverview(db, moderatorSubject, {
    instanceId,
    actorId,
    eventPageSize: 10,
  });
  expect(detail.events.some((event) => event.action === 'inspect')).toBe(true);
  expect(detail.eventsPagination?.total).toBe(1);
  await expect(
    moderationOverview(db, moderatorSubject, { instanceId: otherInstanceId, actorId }),
  ).rejects.toThrow('MODERATION_REQUIRED');
});
it('内部ユーザーと複数の外部組織の表示名・所属元を混同せず検索・詳細へ返す', async () => {
  const prefix = crypto.randomUUID();
  const foreign = await Promise.all(
    [1, 2].map(async (number) => ({
      identity: await organizationIdentity(db, `${prefix}-${number}`),
      origin: `https://foreign-${number}-${prefix}.test`,
      name: `${prefix}外部${number}`,
    })),
  );
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(organizationAccounts)
        .set({ displayName: `${prefix}内部` })
        .where(eq(organizationAccounts.actorId, actorId)),
      rowsD1(
        federationPeers,
        foreign.map((row) => ({
          origin: row.origin,
          name: row.name,
          kid: 'fixture',
          publicKey: 'fixture',
        })),
      ),
      rowsD1(
        federationActors,
        foreign.map((row) => ({
          actorId: row.identity.account.actorId,
          peerOrigin: row.origin,
          sourceActorId: row.identity.account.actorId,
          displayName: row.name,
        })),
      ),
    );
  });
  const overview = await moderationOverview(db, adminSubject, {
    instanceId: null,
    query: prefix,
  });
  expect(overview.users).toHaveLength(3);
  expect(overview.users.find((user) => user.actorId === actorId)).toMatchObject({
    name: `${prefix}内部`,
    origin: '運営検証',
  });
  for (const row of foreign) {
    expect(
      overview.users.find((user) => user.actorId === row.identity.account.actorId),
    ).toMatchObject({ name: row.name, origin: row.origin });
    const searched = await moderationOverview(db, adminSubject, {
      instanceId: null,
      query: row.origin,
    });
    expect(searched.users.map((user) => user.actorId)).toEqual([
      row.identity.account.actorId,
    ]);
    const detail = await moderationOverview(db, adminSubject, {
      instanceId,
      actorId: row.identity.account.actorId,
    });
    expect(detail.target).toMatchObject({ name: row.name, origin: row.origin });
  }
});

it('組織一覧は全インスタンスの権限・処分・通報を集計し、選択先の権限は分離する', async () => {
  await mutateSanction(db, adminSubject, ban({ instanceId: otherInstanceId }));
  await setInstanceGrants(db, adminSubject, {
    id: otherInstanceId,
    actorId,
    expected: '',
    permissions: ['questions'],
  });
  const reporters = await Promise.all(
    ['reporter-one', 'reporter-two'].map((subject) => organizationIdentity(db, subject)),
  );
  await changeD1(db, async (writes) => {
    writes.push(
      rowsD1(
        userReports,
        reporters.map((reporter, index) => ({
          id: crypto.randomUUID(),
          organizationId,
          instanceId: index ? otherInstanceId : instanceId,
          actorId,
          reporterId: reporter.account.actorId,
          matchId: crypto.randomUUID(),
          reason: '確認対象',
        })),
      ),
    );
  });
  const overview = await moderationOverview(db, adminSubject, {
    instanceId: null,
    filter: 'reports',
  });
  expect(overview.users.find((user) => user.actorId === actorId)).toMatchObject({
    reportCount: 2,
    permissions: ['questions'],
    sanctions: [expect.objectContaining({ instanceId: otherInstanceId })],
  });
  const aggregate = await moderationOverview(db, adminSubject, {
    instanceId: null,
    actorId,
  });
  expect(aggregate.reports).toHaveLength(2);
  const first = await moderationOverview(db, adminSubject, { instanceId, actorId });
  const second = await moderationOverview(db, adminSubject, {
    instanceId: otherInstanceId,
    actorId,
  });
  expect(first.target?.permissions).toEqual([]);
  expect(second.target?.permissions).toEqual(['questions']);
  expect(first.reports).toHaveLength(1);
  await expect(
    moderationOverview(db, moderatorSubject, { instanceId: null }),
  ).rejects.toThrow('ADMIN_REQUIRED');
});

it('組織一覧からの一括BANは管理者だけに限定し、インスタンス処分を上書きしない', async () => {
  await mutateSanction(db, adminSubject, ban());
  const input = {
    instanceId: null,
    action: 'bulk',
    batchAction: 'add',
    kind: 'ban',
    restrictions: [],
    expiresAt: null,
    reason: '組織全体の処分',
    operationId: crypto.randomUUID(),
    targets: [{ actorId, expected: '' }],
  };
  await expect(bulkSanctions(db, moderatorSubject, input)).rejects.toThrow(
    'ADMIN_REQUIRED',
  );
  await expect(
    bulkSanctions(db, adminSubject, { ...input, kind: 'timeout' }),
  ).rejects.toThrow('INVALID_SANCTION');
  await bulkSanctions(db, adminSubject, input);
  await bulkSanctions(db, adminSubject, input);
  expect(
    (await actorSanctions(db, organizationId, actorId))
      .map((row) => row.instanceId)
      .sort(),
  ).toEqual([instanceId, null].sort());
});

it('組織全体で選んだ通報と異議申し立てを管理者が処理でき、担当者の範囲を広げない', async () => {
  const reporter = await organizationIdentity(db, 'reporter');
  const reports = [instanceId, otherInstanceId].map((id) => ({
    id: crypto.randomUUID(),
    organizationId,
    instanceId: id,
    actorId,
    reporterId: reporter.account.actorId,
    matchId: crypto.randomUUID(),
    reason: '確認対象',
  }));
  await changeD1(db, async (writes) => {
    writes.push(rowsD1(userReports, reports));
  });
  const resolve = workflow('resolveReports', {
    instanceId: null,
    actorId,
    ids: reports.map((report) => report.id),
    reason: '確認済み',
  });
  await expect(moderationWorkflow(db, moderatorSubject, resolve)).rejects.toThrow(
    'ADMIN_REQUIRED',
  );
  await moderationWorkflow(db, adminSubject, resolve);
  expect(
    (
      await moderationOverview(db, adminSubject, { instanceId: null, actorId })
    ).reports?.every((report) => report.resolvedAt),
  ).toBe(true);
  const sanction = ban({ instanceId: otherInstanceId });
  await mutateSanction(db, adminSubject, sanction);
  const appeal = workflow('appeal', { id: sanction.operationId, reason: '再確認を希望' });
  await moderationWorkflow(db, playerSubject, appeal);
  const decide = workflow('decideAppeal', {
    instanceId: null,
    id: appeal.operationId,
    sanctionRevision: 1,
    decision: 'revoke',
    reason: '確認済み',
  });
  await expect(moderationWorkflow(db, moderatorSubject, decide)).rejects.toThrow(
    'ADMIN_REQUIRED',
  );
  await moderationWorkflow(db, adminSubject, decide);
  expect((await actorSanctions(db, organizationId, actorId))[0].revokedAt).toBeTruthy();
});

it('参加結果に基づく通報を限定し、100件の通報解決と再送を一括で確定する', async () => {
  const reporter = await organizationIdentity(db, 'reporter');
  const [instance] = await db
    .select()
    .from(instances)
    .where(eq(instances.id, instanceId));
  const matchId = crypto.randomUUID();
  const evidence = {
    owner: instance.owner,
    matchId,
    players: [{ id: reporter.account.actorId }, { id: actorId }],
  } as ResultRecord;
  const input = workflow('report', {
    instanceId,
    actorId,
    matchId,
    reason: '不適切な行為',
  });
  await moderationWorkflow(db, 'reporter', input, evidence);
  await moderationWorkflow(db, 'reporter', input, evidence);
  await expect(
    moderationWorkflow(
      db,
      playerSubject,
      workflow('report', { instanceId, actorId, matchId, reason: '自己通報' }),
      evidence,
    ),
  ).rejects.toThrow('REPORT_NOT_ALLOWED');
  const rows = Array.from({ length: 99 }, () => ({
    id: crypto.randomUUID(),
    organizationId,
    instanceId,
    actorId,
    reporterId: reporter.account.actorId,
    matchId,
    reason: '確認対象',
  }));
  await changeD1(db, async (writes) => {
    writes.push(rowsD1(userReports, rows));
  });
  const ids = [String(input.operationId), ...rows.map((row) => row.id)];
  const resolve = workflow('resolveReports', {
    instanceId,
    actorId,
    ids,
    reason: '対応済み',
  });
  await moderationWorkflow(db, moderatorSubject, resolve);
  await moderationWorkflow(db, moderatorSubject, resolve);
  expect(
    (
      await db.select().from(userReports).where(eq(userReports.instanceId, instanceId))
    ).every((row) => row.resolvedAt),
  ).toBe(true);
});

it('BAN異議申し立ての重複・権限・版を検査し、取消と通知を同時に確定する', async () => {
  const input = ban({ organizationWide: true });
  await mutateSanction(db, adminSubject, input);
  const appeal = workflow('appeal', { id: input.operationId, reason: '再確認を希望' });
  await moderationWorkflow(db, playerSubject, appeal);
  await expect(
    moderationWorkflow(
      db,
      playerSubject,
      workflow('appeal', { id: input.operationId, reason: '再確認を希望' }),
    ),
  ).rejects.toThrow('APPEAL_PENDING');
  const decide = workflow('decideAppeal', {
    instanceId,
    id: appeal.operationId,
    sanctionRevision: 1,
    decision: 'revoke',
    reason: '解除',
  });
  await expect(moderationWorkflow(db, moderatorSubject, decide)).rejects.toThrow(
    'ADMIN_REQUIRED',
  );
  await moderationWorkflow(db, adminSubject, decide);
  await moderationWorkflow(db, adminSubject, decide);
  const personal = await personalModeration(db, playerSubject, {});
  expect(personal.sanctions).toHaveLength(0);
  expect(personal.appeals[0].decision).toBe('revoke');
  await personalModeration(db, playerSubject, { readIds: [appeal.operationId] });
  expect(
    (
      await db.select().from(sanctionAppeals).where(eq(sanctionAppeals.actorId, actorId))
    )[0].readAt,
  ).not.toBeNull();
});

it('管理者引き継ぎは本人の承諾時に双方を更新し、再送で元管理者を復活させない', async () => {
  const invite = workflow('inviteAdmin', { actorId, keepSender: false });
  await moderationWorkflow(db, adminSubject, invite);
  expect((await organizationIdentity(db, adminSubject)).account.administrator).toBe(true);
  const accept = workflow('acceptAdmin', { id: invite.operationId });
  await expect(moderationWorkflow(db, moderatorSubject, accept)).rejects.toThrow(
    'INVITATION_INVALID',
  );
  await moderationWorkflow(db, playerSubject, accept);
  await moderationWorkflow(db, playerSubject, accept);
  expect((await organizationIdentity(db, playerSubject)).account.administrator).toBe(
    true,
  );
  expect((await organizationIdentity(db, adminSubject)).account.administrator).toBe(
    false,
  );
  expect(
    (
      await db
        .select()
        .from(administratorTransfers)
        .where(eq(administratorTransfers.senderId, adminId))
    )[0].state,
  ).toBe('accepted');
  await expect(
    moderationWorkflow(
      db,
      adminSubject,
      workflow('inviteAdmin', { actorId: adminId, keepSender: true }),
    ),
  ).rejects.toThrow('ADMIN_REQUIRED');
});

it('通知既読は本人宛てだけを更新し、取り消された招待を承諾できない', async () => {
  const invite = workflow('inviteAdmin', { actorId, keepSender: true });
  await moderationWorkflow(db, adminSubject, invite);
  await personalModeration(db, moderatorSubject, { readIds: [invite.operationId] });
  expect(
    (
      await db
        .select()
        .from(administratorTransfers)
        .where(eq(administratorTransfers.senderId, adminId))
    )[0].readAt,
  ).toBeNull();
  await personalModeration(db, playerSubject, { readIds: [invite.operationId] });
  expect(
    (
      await db
        .select()
        .from(administratorTransfers)
        .where(eq(administratorTransfers.senderId, adminId))
    )[0].readAt,
  ).not.toBeNull();
  await moderationWorkflow(
    db,
    adminSubject,
    workflow('cancelAdmin', { id: invite.operationId }),
  );
  await expect(
    moderationWorkflow(
      db,
      playerSubject,
      workflow('acceptAdmin', { id: invite.operationId }),
    ),
  ).rejects.toThrow('EDIT_CONFLICT');
  expect(
    await db
      .select({ total: sql<number>`count(*)` })
      .from(moderationRequests)
      .where(and(eq(moderationRequests.operatorId, adminId))),
  ).toEqual([{ total: 2 }]);
});
