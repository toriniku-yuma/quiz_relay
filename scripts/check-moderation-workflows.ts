import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  instanceGrants,
  instances,
  moderationRequests,
  moderationSanctions,
  organizationAccounts,
  sanctionAppeals,
  userReports,
} from '../src/worker/db/schema.ts';
import { rules } from '../src/worker/game/rules.ts';
import {
  moderationOverview,
  mutateSanction,
  personalModeration,
  rankingExclusions,
} from '../src/worker/organization/moderation.ts';
import { moderationWorkflow } from '../src/worker/organization/workflow.ts';
import { commitResult } from '../src/worker/results/database.ts';
import { readInvestigation } from '../src/worker/results/investigation.ts';
import { readResults } from '../src/worker/results/read.ts';
import type { ResultRecord } from '../src/worker/results/record.ts';
export async function verifyWorkflows(
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
  const flow = (
    subject: string,
    body: Record<string, unknown>,
    evidence?: ResultRecord,
  ) => run((tx) => moderationWorkflow(tx, subject, body, evidence));
  const mutate = (subject: string, body: Record<string, unknown>) =>
    run((tx) => mutateSanction(tx, subject, body));
  const overview = () =>
    run((tx) =>
      moderationOverview(tx, 'reviewer', {
        instanceId,
        sort: 'reports',
        filter: 'reports',
        pageSize: 10,
      }),
    );
  const [scope] = await db.select().from(instances).where(eq(instances.id, instanceId));
  const ref = { owner: scope.owner, id: 'fixture', version: 1 };
  const record: ResultRecord = {
    version: 1,
    owner: scope.owner,
    matchId: crypto.randomUUID(),
    kind: 'ranked',
    startedAt: 1000,
    result: {
      id: crypto.randomUUID(),
      finishedAt: 50000,
      winnerId: actors[1],
      reason: 'exhausted',
    },
    definition: {
      competition: ref,
      ruleset: ref,
      questionSet: ref,
      rulesHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
      playersPerMatch: 3,
      rules: { ...rules, showSelections: false },
    },
    ratingVersion: 1,
    players: actors.slice(0, 3).map((id, i) => ({
      id,
      name: `検証${i}`,
      correct: i === 1 ? 1 : 0,
      mistakes: 0,
      locked: false,
      disqualified: false,
      connected: true,
      ratingDelta: i === 1 ? 20 : -20,
    })),
    answerStats: [{ actorId: actors[1], result: 'correct', elapsedMs: 1000 }],
  };
  for (let i = 1; i <= 31; i++)
    await commitResult(db, {
      ...record,
      matchId: crypto.randomUUID(),
      result: { ...record.result, id: crypto.randomUUID(), finishedAt: i * 1000 },
    });
  await commitResult(db, record);
  const report = {
    action: 'report',
    instanceId,
    actorId: actors[1],
    resultId: record.result.id,
    reason: '検証通報',
    operationId: crypto.randomUUID(),
  };
  await flow('admin', report, record);
  await flow('admin', report, record);
  const repeated = { ...report, operationId: crypto.randomUUID() };
  await flow('admin', repeated, record);
  const another = { ...report, operationId: crypto.randomUUID() };
  await flow('reviewer', another, record);
  assert.equal((await overview()).users[0].reportCount, 2);
  assert.equal((await overview()).pagination?.total, 1);
  await assert.rejects(
    flow('author', { ...report, operationId: crypto.randomUUID() }, record),
    /REPORT_NOT_ALLOWED/,
  );
  await assert.rejects(
    flow('outsider', { ...report, operationId: crypto.randomUUID() }, record),
    /REPORT_NOT_ALLOWED/,
  );
  await assert.rejects(
    flow(
      'admin',
      { ...report, instanceId: otherId, operationId: crypto.randomUUID() },
      record,
    ),
    /REPORT_NOT_ALLOWED/,
  );
  await flow('reviewer', {
    action: 'resolveReports',
    instanceId,
    actorId: actors[1],
    ids: [report.operationId],
    reason: '一部を対応',
    operationId: crypto.randomUUID(),
  });
  assert.equal((await overview()).users[0].reportCount, 2);
  await flow('reviewer', {
    action: 'resolveReports',
    instanceId,
    actorId: actors[1],
    ids: [repeated.operationId],
    reason: '重複の理由も確認',
    operationId: crypto.randomUUID(),
  });
  assert.equal((await overview()).users[0].reportCount, 1);
  await assert.rejects(
    run((tx) =>
      tx
        .update(userReports)
        .set({ reason: '改ざん' })
        .where(eq(userReports.id, report.operationId)),
    ),
  );
  const investigation = await readInvestigation(
    db,
    scope.owner,
    actors[1],
    record.result.id,
    { page: 2, pageSize: 10, sample: 7 },
  );
  assert.equal(investigation.pagination.total, 31);
  assert.equal(investigation.rows.length, 10);
  assert.equal(investigation.summary.matches, 7);
  assert.equal(investigation.summary.correctMs, 1000);
  const all = await readInvestigation(db, scope.owner, actors[1], record.result.id, {
    page: 1,
    pageSize: 30,
    sample: 'all',
  });
  assert.equal(all.rows.length, 30);
  assert.equal(all.summary.matches, 31);
  const fullHistory = await readInvestigation(db, scope.owner, actors[1], null, {
    page: 1,
    pageSize: 100,
    sample: 'all',
  });
  assert.equal(fullHistory.reported, null);
  assert.equal(fullHistory.pagination.total, 32);
  assert.equal(fullHistory.summary.matches, 32);
  for (const sort of [
    'finishedAt',
    'outcome',
    'correct',
    'wrong',
    'timeouts',
    'correctMs',
    'wrongMs',
    'ratingDelta',
  ]) {
    for (const direction of ['asc', 'desc']) {
      const sorted = await readInvestigation(
        db,
        scope.owner,
        actors[1],
        record.result.id,
        { page: 1, pageSize: 100, sample: 7, sort, direction },
      );
      const second = await readInvestigation(
        db,
        scope.owner,
        actors[1],
        record.result.id,
        { page: 2, pageSize: 10, sample: 7, sort, direction },
      );
      assert.deepEqual(second.rows, sorted.rows.slice(10, 20));
      assert.deepEqual(sorted.summary, investigation.summary);
      assert.deepEqual(sorted.reported, investigation.reported);
    }
  }
  const oldest = await readInvestigation(db, scope.owner, actors[1], null, {
    sort: 'finishedAt',
    direction: 'asc',
    pageSize: 100,
  });
  assert.deepEqual(
    oldest.rows.map((result) => result.resultId),
    fullHistory.rows.map((result) => result.resultId).reverse(),
  );
  const originalRanking = await readResults(db, scope.owner, actors[1]);
  const excluded = await readResults(db, scope.owner, actors[1], [actors[1]]);
  assert.equal(originalRanking.ranking[0].actorId, actors[1]);
  assert.ok(!excluded.ranking.some((rankingEntry) => rankingEntry.actorId === actors[1]));
  assert.equal(excluded.ranking[0].rank, 1);
  await db
    .insert(instanceGrants)
    .values({ instanceId: otherId, actorId: actors[3], permission: 'users' });
  const ban = {
    action: 'add',
    instanceId,
    organizationWide: true,
    actorId: actors[1],
    kind: 'ban',
    restrictions: [],
    expiresAt: null,
    reason: '全体BAN検証',
    operationId: crypto.randomUUID(),
  };
  await mutate('reviewer', ban);
  const appeal = {
    action: 'appeal',
    id: ban.operationId,
    reason: '異議申し立て検証',
    operationId: crypto.randomUUID(),
  };
  await flow('author', appeal);
  await flow('author', appeal);
  await assert.rejects(
    flow('author', { ...appeal, operationId: crypto.randomUUID() }),
    /APPEAL_PENDING/,
  );
  await flow('outsider', {
    action: 'decideAppeal',
    instanceId: otherId,
    id: appeal.operationId,
    decision: 'maintain',
    sanctionRevision: 1,
    reason: '維持の理由',
    operationId: crypto.randomUUID(),
  });
  const again = { ...appeal, operationId: crypto.randomUUID() };
  await flow('author', again);
  const decision = {
    action: 'decideAppeal',
    instanceId: otherId,
    id: again.operationId,
    decision: 'revoke',
    sanctionRevision: 2,
    reason: '取り消す理由',
    operationId: crypto.randomUUID(),
  };
  await mutate('reviewer', {
    ...ban,
    action: 'change',
    id: ban.operationId,
    revision: 1,
    reason: '申立後に理由を更新',
    operationId: crypto.randomUUID(),
  });
  await assert.rejects(
    flow('outsider', { ...decision, sanctionRevision: 1 }),
    /EDIT_CONFLICT/,
  );
  await flow('outsider', decision);
  await flow('outsider', decision);
  assert.ok(
    (
      await db
        .select()
        .from(moderationSanctions)
        .where(eq(moderationSanctions.id, ban.operationId))
    )[0].revokedAt,
  );
  assert.equal(
    (
      await db
        .select()
        .from(sanctionAppeals)
        .where(eq(sanctionAppeals.id, again.operationId))
    )[0].decision,
    'revoke',
  );
  const notices = await run((tx) => personalModeration(tx, 'author', {}));
  assert.ok(
    notices.notifications.some((notification) => notification.id === again.operationId),
  );
  const manualBan = { ...ban, operationId: crypto.randomUUID() };
  await mutate('reviewer', manualBan);
  const manualAppeal = {
    ...appeal,
    id: manualBan.operationId,
    operationId: crypto.randomUUID(),
  };
  await flow('author', manualAppeal);
  await mutate('outsider', {
    ...manualBan,
    instanceId: otherId,
    id: manualBan.operationId,
    revision: 1,
    action: 'revoke',
    operationId: crypto.randomUUID(),
  });

  const [settledAppeal] = await db
    .select()
    .from(sanctionAppeals)
    .where(eq(sanctionAppeals.id, manualAppeal.operationId));
  assert.equal(settledAppeal.decision, 'revoke');
  assert.ok(settledAppeal.resolvedAt);
  for (const row of (await db.select().from(moderationSanctions)).filter(
    (sanction) =>
      sanction.actorId === actors[1] && sanction.kind === 'ban' && !sanction.revokedAt,
  )) {
    await mutate('reviewer', {
      instanceId,
      organizationWide: row.instanceId === null,
      actorId: actors[1],
      action: 'revoke',
      id: row.id,
      revision: row.revision,
      operationId: crypto.randomUUID(),
      reason: 'ランキング復帰の検証',
    });
  }
  assert.ok(
    !(
      await run((tx) => rankingExclusions(tx, input.organizationId, instanceId))
    ).includes(actors[1]),
  );
  const localBan = { ...ban, organizationWide: false, operationId: crypto.randomUUID() };
  await mutate('reviewer', localBan);
  for (const kind of ['partial', 'timeout']) {
    await assert.rejects(
      mutate('reviewer', {
        ...localBan,
        action: 'change',
        id: localBan.operationId,
        revision: 1,
        kind,
        restrictions: kind === 'partial' ? ['submit'] : [],
        expiresAt:
          kind === 'timeout' ? new Date(Date.now() + 120000).toISOString() : null,
        operationId: crypto.randomUUID(),
      }),
      /BAN_REQUIRES_REVOKE/,
    );
  }
  assert.ok(
    (await run((tx) => rankingExclusions(tx, input.organizationId, instanceId))).includes(
      actors[1],
    ),
  );
  assert.ok(
    !(await run((tx) => rankingExclusions(tx, input.organizationId, otherId))).includes(
      actors[1],
    ),
  );
  await mutate('reviewer', {
    ...localBan,
    id: localBan.operationId,
    revision: 1,
    action: 'revoke',
    operationId: crypto.randomUUID(),
  });
  const restored = await readResults(
    db,
    scope.owner,
    actors[1],
    await run((tx) => rankingExclusions(tx, input.organizationId, instanceId)),
  );
  assert.deepEqual(restored.ranking, originalRanking.ranking);
  await db.insert(organizationAccounts).values(
    Array.from({ length: 31 }, (_, i) => ({
      organizationId: input.organizationId,
      subject: `paging-${i}`,
      actorId: (i + 100).toString(16).padStart(64, '0'),
      displayName: `ページ検証${i}`,
    })),
  );
  const page3 = await run((tx) =>
    moderationOverview(tx, 'reviewer', { instanceId, page: 3, pageSize: 10 }),
  );
  const page4 = await run((tx) =>
    moderationOverview(tx, 'reviewer', { instanceId, page: 4, pageSize: 10 }),
  );
  assert.equal(page3.pagination?.total, 35);
  assert.equal(page3.users.length, 10);
  assert.equal(page4.users.length, 5);
  assert.ok(
    !page3.users.some((user) =>
      page4.users.some((other) => other.actorId === user.actorId),
    ),
  );
  for (const sort of [
    'name',
    'origin',
    'role',
    'sanction',
    'expiresAt',
    'reports',
    'appeals',
  ]) {
    for (const direction of ['asc', 'desc']) {
      const full = await run((tx) =>
        moderationOverview(tx, 'reviewer', {
          instanceId,
          sort,
          direction,
          pageSize: 100,
        }),
      );
      const second = await run((tx) =>
        moderationOverview(tx, 'reviewer', {
          instanceId,
          sort,
          direction,
          pageSize: 10,
          page: 2,
        }),
      );
      assert.deepEqual(
        second.users.map((user) => user.actorId),
        full.users.slice(10, 20).map((user) => user.actorId),
      );
      if (sort === 'role' && direction === 'desc')
        assert.equal(full.users[0].administrator, true);
    }
  }
  const permissions = {
    action: 'permissions',
    instanceId,
    actorId: actors[3],
    permissions: ['users'],
    expected: '',
    operationId: crypto.randomUUID(),
  };
  await assert.rejects(flow('reviewer', permissions), /ADMIN_REQUIRED/);
  await flow('admin', permissions);
  await flow('admin', permissions);
  const invite = {
    action: 'inviteAdmin',
    actorId: actors[3],
    keepSender: false,
    operationId: crypto.randomUUID(),
  };
  await flow('admin', invite);
  await assert.rejects(
    flow('author', {
      action: 'acceptAdmin',
      id: invite.operationId,
      operationId: crypto.randomUUID(),
    }),
    /INVITATION_INVALID/,
  );
  const accept = {
    action: 'acceptAdmin',
    id: invite.operationId,
    operationId: crypto.randomUUID(),
  };
  await flow('outsider', accept);
  await flow('outsider', accept);
  assert.equal(
    (
      await db
        .select()
        .from(organizationAccounts)
        .where(eq(organizationAccounts.actorId, actors[0]))
    )[0].administrator,
    false,
  );
  assert.equal(
    (
      await db
        .select()
        .from(organizationAccounts)
        .where(eq(organizationAccounts.actorId, actors[3]))
    )[0].administrator,
    true,
  );
  await assert.rejects(
    flow('admin', { ...permissions, operationId: crypto.randomUUID() }),
    /ADMIN_REQUIRED/,
  );
  await assert.rejects(
    run((tx) =>
      tx.delete(moderationRequests).where(eq(moderationRequests.id, accept.operationId)),
    ),
  );
  console.log(
    'PASS: reports/evidence/deduplication, paginated history and independent aggregates, ranking exclusion, moderator global BAN/cancel, appeals and notifications, permission replay, accepted administrator transfer and immutable audit',
  );
}
