import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  moderationEvents,
  moderationRequests,
  organizationEvents,
  probeRuns,
  questionNotifications,
  questionReports,
  questionReviewCases,
  userReports,
} from '../src/worker/db/schema.ts';

export async function verifyRetention(
  db: PostgresJsDatabase,
  organizationId: string,
  instanceId: string,
  actors: string[],
) {
  const old = new Date(Date.now() - 366 * 86400000).toISOString();
  const id = crypto.randomUUID(),
    recent = crypto.randomUUID();
  await db.insert(moderationRequests).values([
    {
      id,
      organizationId,
      operatorId: actors[0],
      requestHash: 'a'.repeat(64),
      details: {},
      createdAt: old,
    },
    {
      id: recent,
      organizationId,
      operatorId: actors[0],
      requestHash: 'b'.repeat(64),
      details: {},
    },
  ]);
  const eventId = crypto.randomUUID();
  await db.insert(moderationEvents).values({
    id: eventId,
    organizationId,
    instanceId,
    actorId: actors[1],
    operatorId: actors[0],
    action: 'inspect',
    reason: '調査',
    requestHash: 'a'.repeat(64),
    createdAt: old,
  });
  const reportId = crypto.randomUUID();
  await db.insert(userReports).values({
    id: reportId,
    organizationId,
    instanceId,
    actorId: actors[1],
    reporterId: actors[0],
    resultId: crypto.randomUUID(),
    reason: '未解決',
    createdAt: old,
  });
  const notificationId = crypto.randomUUID(),
    recentNotice = crypto.randomUUID();
  await db.insert(questionNotifications).values([
    {
      id: notificationId,
      instanceId,
      actorId: actors[0],
      message: '期限切れ',
      createdAt: new Date(Date.now() - 91 * 86400000).toISOString(),
    },
    {
      id: recentNotice,
      instanceId,
      actorId: actors[0],
      message: '期限内',
      createdAt: new Date(Date.now() - 89 * 86400000).toISOString(),
    },
  ]);
  const auditId = crypto.randomUUID();
  await db.insert(organizationEvents).values({
    id: auditId,
    actorId: actors[0],
    instanceId,
    action: 'rename',
    details: {},
    occurredAt: old,
  });
  const logId = crypto.randomUUID();
  await db
    .insert(probeRuns)
    .values({ id: logId, createdAt: new Date(Date.now() - 31 * 86400000).toISOString() });
  const questionId = `retention-${crypto.randomUUID()}`;
  await db.insert(questionReviewCases).values([
    { instanceId, questionId, kind: 'defect', round: 1, count: 1, createdAt: old },
    { instanceId, questionId, kind: 'defect', round: 2, count: 2, createdAt: old },
    {
      instanceId,
      questionId,
      kind: 'category',
      round: 1,
      count: 1,
      resolved: true,
      reason: '古い解決',
      createdAt: old,
      resolvedAt: old,
    },
    {
      instanceId,
      questionId,
      kind: 'category',
      round: 2,
      count: 1,
      resolved: true,
      reason: '最近の解決',
      createdAt: old,
      resolvedAt: new Date().toISOString(),
    },
  ]);
  const recentReportId = crypto.randomUUID();
  await db.insert(questionReports).values([
    ...[1, 2].map((round) => ({
      id: crypto.randomUUID(),
      instanceId,
      questionId,
      kind: 'defect' as const,
      round,
      actorId: actors[0],
      reason: '期限切れ',
      createdAt: old,
    })),
    {
      id: recentReportId,
      instanceId,
      questionId,
      kind: 'defect',
      round: 2,
      actorId: actors[1],
      reason: '最近の通報',
    },
    ...[1, 2].map((round) => ({
      id: crypto.randomUUID(),
      instanceId,
      questionId,
      kind: 'category' as const,
      round,
      actorId: actors[0],
      reason: '期限切れ',
      createdAt: old,
    })),
  ]);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      await tx.execute(sql`select quiz_game.expire_records()`);
    }),
  );
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quiz_erasure`);
    await tx.execute(sql`select quiz_game.expire_records()`);
    await tx.execute(sql`select quiz_game.expire_records()`);
  });
  assert.equal(
    (await db.select().from(moderationRequests).where(eq(moderationRequests.id, id)))
      .length,
    0,
  );
  assert.equal(
    (await db.select().from(moderationRequests).where(eq(moderationRequests.id, recent)))
      .length,
    1,
  );
  assert.equal(
    (await db.select().from(moderationEvents).where(eq(moderationEvents.id, eventId)))
      .length,
    0,
  );
  assert.equal(
    (await db.select().from(userReports).where(eq(userReports.id, reportId))).length,
    0,
  );
  assert.equal(
    (
      await db
        .select()
        .from(questionNotifications)
        .where(eq(questionNotifications.id, notificationId))
    ).length,
    0,
  );
  assert.equal(
    (
      await db
        .select()
        .from(questionNotifications)
        .where(eq(questionNotifications.id, recentNotice))
    ).length,
    1,
  );
  assert.equal(
    (await db.select().from(organizationEvents).where(eq(organizationEvents.id, auditId)))
      .length,
    0,
  );
  assert.equal(
    (await db.select().from(probeRuns).where(eq(probeRuns.id, logId))).length,
    0,
  );
  const retainedReports = await db
    .select()
    .from(questionReports)
    .where(eq(questionReports.questionId, questionId));
  assert.equal(retainedReports.length, 1);
  assert.equal(retainedReports[0].id, recentReportId);
  assert.ok(Date.parse(retainedReports[0].createdAt) > Date.now() - 60000);
  const retainedCases = await db
    .select()
    .from(questionReviewCases)
    .where(eq(questionReviewCases.questionId, questionId));
  assert.deepEqual(
    retainedCases
      .map((row) => ({
        kind: row.kind,
        round: row.round,
        count: row.count,
        reason: row.reason,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      { kind: 'category', round: 2, count: 0, reason: '最近の解決' },
      { kind: 'defect', round: 2, count: 1, reason: '' },
    ],
  );
  console.log(
    'PASS: 90-day notifications, 365-day operation/question reports including unresolved cases, retained report count reconciliation, recent resolutions and 30-day probe logs, cleanup privilege separation',
  );
}
