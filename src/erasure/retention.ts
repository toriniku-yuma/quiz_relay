import { eq, sql } from 'drizzle-orm';
import { changeD1, type Database } from '../worker/db/d1.ts';
import {
  administratorTransfers,
  federationFavorites,
  federationQuestionStaging,
  federationTargets,
  guestSessions,
  maintenanceCheckpoints,
  moderationEvents,
  moderationRequests,
  organizationEvents,
  probeRuns,
  questionNotifications,
  questionReports,
  questionReviewCases,
  questionSubmissionEvents,
  sanctionAppeals,
  userReports,
} from '../worker/db/schema.ts';

export async function expireRecords(db: Database, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10),
    cutoff = (days: number) => new Date(now - days * 86400000).toISOString();
  return changeD1(db, async (writes) => {
    const [previous] = await db
      .select()
      .from(maintenanceCheckpoints)
      .where(eq(maintenanceCheckpoints.id, 'retention'));
    if (previous?.completedDay === day) return false;
    for (const table of [
      questionSubmissionEvents,
      moderationEvents,
      userReports,
      sanctionAppeals,
      administratorTransfers,
      moderationRequests,
    ])
      writes.push(db.delete(table).where(sql`${table.createdAt}<=${cutoff(365)}`));
    writes.push(
      db
        .delete(federationTargets)
        .where(
          sql`${federationTargets.checkedAt}<=${now - 30 * 86400000} and not exists(select 1 from ${federationFavorites} where ${federationFavorites.peerOrigin}=${federationTargets.peerOrigin} and ${federationFavorites.instanceId}=${federationTargets.instanceId})`,
        ),
      db
        .delete(organizationEvents)
        .where(sql`${organizationEvents.occurredAt}<=${cutoff(365)}`),
      db
        .delete(questionNotifications)
        .where(sql`${questionNotifications.createdAt}<=${cutoff(90)}`),
      db.delete(probeRuns).where(sql`${probeRuns.createdAt}<=${cutoff(30)}`),
      db
        .delete(federationQuestionStaging)
        .where(sql`${federationQuestionStaging.createdAt}<=${now - 30 * 86400000}`),
      db
        .delete(guestSessions)
        .where(sql`${guestSessions.expiresAt}<=${new Date(now).toISOString()}`),
    );
    // Only cases affected by expired reports need a new count. Update before deleting their reports.
    writes.push(
      db
        .update(questionReviewCases)
        .set({
          count: sql`(select count(*) from ${questionReports} where ${questionReports.instanceId}=${questionReviewCases.instanceId} and ${questionReports.questionId}=${questionReviewCases.questionId} and ${questionReports.kind}=${questionReviewCases.kind} and ${questionReports.round}=${questionReviewCases.round} and ${questionReports.createdAt}>${cutoff(365)})`,
        })
        .where(
          sql`exists(select 1 from ${questionReports} where ${questionReports.instanceId}=${questionReviewCases.instanceId} and ${questionReports.questionId}=${questionReviewCases.questionId} and ${questionReports.kind}=${questionReviewCases.kind} and ${questionReports.round}=${questionReviewCases.round} and ${questionReports.createdAt}<=${cutoff(365)})`,
        ),
      db.delete(questionReports).where(sql`${questionReports.createdAt}<=${cutoff(365)}`),
      db
        .delete(questionReviewCases)
        .where(
          sql`${questionReviewCases.count}=0 and coalesce(${questionReviewCases.resolvedAt},${questionReviewCases.createdAt})<=${cutoff(365)}`,
        ),
      db
        .insert(maintenanceCheckpoints)
        .values({ id: 'retention', completedDay: day })
        .onConflictDoUpdate({
          target: maintenanceCheckpoints.id,
          set: { completedDay: day },
        }),
    );
    return true;
  });
}
