import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { changeD1, type Database } from '../worker/db/d1.ts';
import {
  instanceRooms,
  instances,
  accountWithdrawals as jobs,
  moderationEvents,
  moderationRequests,
  moderationSanctions,
  organizationAccounts,
  organizationEvents,
  personalQuestionSets,
  questionAuthors,
  questionNotifications,
  questionReports,
  questionSets,
  questionSubmissionEvents,
  questionSubmissions,
  questionVersions,
  resultPrivacyJobs,
  sanctionAppeals,
  userReports,
} from '../worker/db/schema.ts';
import type { Env } from '../worker/env.ts';
import { matchmaker } from '../worker/matchmaking/instance.ts';
import { privateSelectionSQL } from '../worker/results/privacy.ts';
import {
  anonymousAuditDetails,
  anonymousAuditReason,
  anonymousSanction,
} from './audit.ts';
import { erasureBatch } from './limits.ts';

async function eraseWithdrawalAudit(db: Database, id: string) {
  return changeD1(db, async (writes) => {
    const [job] = await db
      .select({ actorId: jobs.actorId, withdrawn: organizationAccounts.withdrawnAt })
      .from(jobs)
      .innerJoin(organizationAccounts, eq(organizationAccounts.actorId, jobs.actorId))
      .where(eq(jobs.id, id));
    if (!job?.withdrawn) throw new Error('WITHDRAWAL_REQUIRED');
    const actor = job.actorId;
    writes.push(
      db
        .update(moderationEvents)
        .set({
          reason: '退会に伴い削除',
          before: anonymousSanction(moderationEvents.before),
          after: anonymousSanction(moderationEvents.after),
        })
        .where(
          sql`${moderationEvents.actorId}=${actor} or ${moderationEvents.operatorId}=${actor}`,
        ),
      db
        .update(userReports)
        .set({
          reason: '退会に伴い削除',
          resolution: anonymousAuditReason(userReports.resolution),
        })
        .where(
          sql`${userReports.actorId}=${actor} or ${userReports.operatorId}=${actor} or ${userReports.reporterId}=${actor}`,
        ),
      db
        .update(sanctionAppeals)
        .set({
          reason: '退会に伴い削除',
          resolution: anonymousAuditReason(sanctionAppeals.resolution),
        })
        .where(
          sql`${sanctionAppeals.actorId}=${actor} or ${sanctionAppeals.operatorId}=${actor}`,
        ),
      db
        .update(organizationEvents)
        .set({ details: anonymousAuditDetails(organizationEvents.details) })
        .where(
          sql`${organizationEvents.actorId}=${actor} or json_extract(${organizationEvents.details}, '$.actorId')=${actor} or exists(select 1 from json_each(${organizationEvents.details}, '$.targets') target where target.value=${actor} or json_extract(case when target.type='object' then target.value else '{}' end,'$.actorId')=${actor})`,
        ),
      db
        .update(moderationRequests)
        .set({ details: anonymousAuditDetails(moderationRequests.details) })
        .where(
          sql`${moderationRequests.operatorId}=${actor} or json_extract(${moderationRequests.details}, '$.actorId')=${actor} or exists(select 1 from json_each(${moderationRequests.details}, '$.targets') target where target.value=${actor} or json_extract(case when target.type='object' then target.value else '{}' end,'$.actorId')=${actor})`,
        ),
      db
        .update(questionSubmissionEvents)
        .set({ reason: '退会に伴い削除' })
        .where(eq(questionSubmissionEvents.actorId, actor)),
      db.delete(questionNotifications).where(eq(questionNotifications.actorId, actor)),
      db
        .update(moderationSanctions)
        .set({ reason: '退会に伴い削除' })
        .where(eq(moderationSanctions.actorId, actor)),
      db
        .update(questionAuthors)
        .set({ reason: '退会に伴い削除' })
        .where(eq(questionAuthors.actorId, actor)),
      db
        .update(questionReports)
        .set({ reason: '退会に伴い削除' })
        .where(eq(questionReports.actorId, actor)),
      db
        .update(questionSubmissions)
        .set({ authorName: '退会ユーザー' })
        .where(eq(questionSubmissions.authorId, actor)),
      db.delete(personalQuestionSets).where(eq(personalQuestionSets.authorId, actor)),
      db
        .update(questionSets)
        .set({
          selection: privateSelectionSQL(questionSets.owner, questionSets.selection),
        })
        .where(sql`json_extract(${questionSets.selection}, '$.authorNames') is not null`),
      db
        .update(jobs)
        .set({ auditErasedAt: new Date().toISOString() })
        .where(eq(jobs.id, id)),
    );
  });
}

export async function anonymizeWithdrawal(
  db: Database,
  env: Pick<Env, 'GAME_ROOM' | 'MATCHMAKER'>,
  id: string,
) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!job || job.erasedAt) return true;
  const [account] = await db
    .select()
    .from(organizationAccounts)
    .where(eq(organizationAccounts.actorId, job.actorId));
  if (!account?.withdrawnAt) throw new Error('WITHDRAWAL_REQUIRED');
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(jobs)
        .set({ lastAttemptAt: new Date().toISOString() })
        .where(eq(jobs.id, id)),
    );
  });
  const maker = matchmaker(env);
  const admission = await maker.beginWithdrawal(job.actorId, job.id);
  if (!admission.ok) throw new Error(admission.code);
  await maker.logoutActor(job.actorId);
  if (!job.auditErasedAt) await eraseWithdrawalAudit(db, id);
  const scopes = await db
    .select()
    .from(instances)
    .where(eq(instances.organizationId, job.organizationId));
  if (scopes.some((scope) => !scope.roomInventoryComplete)) {
    await changeD1(db, async (writes) => {
      writes.push(db.update(jobs).set({ roomCursor: null }).where(eq(jobs.id, id)));
    });
    return false;
  }
  const authored = await db
    .select()
    .from(questionSubmissions)
    .where(
      and(
        eq(questionSubmissions.authorId, job.actorId),
        isNull(questionSubmissions.provenance),
      ),
    );
  const ids = new Set(
    authored.flatMap((row) => [
      row.id,
      row.seriesId,
      ...(row.publishedId ? [row.publishedId] : []),
    ]),
  );
  const versions = ids.size
    ? await db
        .select({ id: questionVersions.questionId })
        .from(questionVersions)
        .innerJoin(instances, eq(instances.owner, questionVersions.owner))
        .where(
          and(
            eq(instances.organizationId, job.organizationId),
            sql`json_extract(${questionVersions.payload}, '$.seriesId') in (select value from json_each(${JSON.stringify([...ids])}))`,
          ),
        )
    : [];
  for (const version of versions) ids.add(version.id);
  const rooms = await db
    .select({ roomId: instanceRooms.roomId })
    .from(instanceRooms)
    .innerJoin(instances, eq(instances.id, instanceRooms.instanceId))
    .where(
      and(
        eq(instances.organizationId, job.organizationId),
        job.roomCursor ? gt(instanceRooms.roomId, job.roomCursor) : undefined,
      ),
    )
    .orderBy(instanceRooms.roomId)
    .limit(erasureBatch.rooms);
  for (const room of rooms)
    await env.GAME_ROOM.get(env.GAME_ROOM.idFromString(room.roomId)).anonymizeAccount(
      job.actorId,
      [...ids],
    );
  await changeD1(db, async (writes) => {
    const [current] = await db.select().from(jobs).where(eq(jobs.id, id));
    if (current && current.roomCursor === job.roomCursor && rooms.length)
      writes.push(
        db
          .update(jobs)
          .set({ roomCursor: rooms[rooms.length - 1].roomId })
          .where(eq(jobs.id, id)),
      );
  });
  if (rooms.length === erasureBatch.rooms) return false;
  await maker.anonymizeAccount(job.actorId, [...ids]);
  return changeD1(db, async (writes) => {
    const [current] = await db.select().from(jobs).where(eq(jobs.id, id));
    const [remaining] = await db
      .select({ id: resultPrivacyJobs.matchId })
      .from(resultPrivacyJobs)
      .where(
        sql`${resultPrivacyJobs.dueAt}<=${new Date().toISOString()} and ${resultPrivacyJobs.matchId} in (select match_id from quiz_game_matches where owner in (select owner from quiz_game_instances where organization_id=${job.organizationId}))`,
      )
      .limit(1);
    if (!current?.authDeletedAt || remaining) return false;
    writes.push(
      db.update(jobs).set({ erasedAt: new Date().toISOString() }).where(eq(jobs.id, id)),
    );
    return true;
  });
}
