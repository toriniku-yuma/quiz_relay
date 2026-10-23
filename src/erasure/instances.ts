import { and, eq, sql } from 'drizzle-orm';
import { changeD1, type Database } from '../worker/db/d1.ts';
import {
  competitions,
  difficultyActors,
  difficultySamples,
  difficultyTrials,
  federationMetadata,
  federationMetadataJobs,
  federationPolicies,
  federationQuestionImports,
  federationQuestionLinks,
  federationQuestionSources,
  federationQuestionStaging,
  federationReservations,
  federationSessions,
  instanceGrants,
  instanceRooms,
  instances,
  instanceDeletions as jobs,
  matches,
  matchmakingSettings,
  moderationEvents,
  moderationRequests,
  moderationSanctions,
  organizationEvents,
  questionAuthors,
  questionAvailability,
  questionCategories,
  questionDifficulty,
  questionImports,
  questionNotifications,
  questionReports,
  questionReviewCases,
  questionSetItems,
  questionSets,
  questionSettings,
  questionSubmissionEvents,
  questionSubmissions,
  questionTags,
  questionVersions,
  resultOutbox,
  resultPlayers,
  roomMembers,
  rulesetVersions,
  sanctionAppeals,
  userReports,
} from '../worker/db/schema.ts';
import { planControlEvent } from '../worker/federation/controls.ts';

async function requireNoRunningMatches(db: Database, owner: string) {
  const [active] = await db
    .select({ id: matches.matchId })
    .from(matches)
    .where(and(eq(matches.owner, owner), eq(matches.status, 'running')))
    .limit(1);
  if (active) throw new Error('RESULT_OR_MATCH_PENDING');
}

async function eraseStoredInstance(db: Database, operationId: string) {
  return changeD1(db, async (writes) => {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, operationId));
    if (!job?.acceptedAt) throw new Error('INSTANCE_DELETION_NOT_ACCEPTED');
    const [instance] = await db
      .select()
      .from(instances)
      .where(eq(instances.id, job.instanceId));
    if (
      (!instance && !job.deletedAt) ||
      (instance &&
        (instance.organizationId !== job.organizationId ||
          instance.owner !== job.owner ||
          instance.name !== job.name ||
          instance.state !== 'archived'))
    )
      throw new Error('INSTANCE_DELETION_CONFLICT');
    await requireNoRunningMatches(db, job.owner);
    writes.push(
      db
        .delete(sanctionAppeals)
        .where(
          sql`${sanctionAppeals.sanctionId} in (select ${moderationSanctions.id} from ${moderationSanctions} where ${moderationSanctions.instanceId}=${job.instanceId})`,
        ),
      db
        .delete(moderationSanctions)
        .where(eq(moderationSanctions.instanceId, job.instanceId)),
      db
        .delete(moderationRequests)
        .where(
          sql`(json_extract(${moderationRequests.details}, '$.instanceId')=${job.instanceId} or json_extract(${moderationRequests.details}, '$.id')=${job.instanceId}) and coalesce(json_extract(${moderationRequests.details}, '$.organizationWide'),0)<>1`,
        ),
    );
    for (const table of [
      moderationEvents,
      userReports,
      organizationEvents,
      questionNotifications,
      questionSubmissionEvents,
      questionImports,
      questionReports,
      questionReviewCases,
      questionDifficulty,
      questionSubmissions,
      questionAuthors,
      questionCategories,
      questionTags,
      questionSettings,
      federationPolicies,
      federationMetadata,
    ])
      writes.push(db.delete(table).where(eq(table.instanceId, job.instanceId)));
    const matchIds = sql`select ${matches.matchId} from ${matches} where ${matches.owner}=${job.owner}`;
    for (const table of [difficultyActors, difficultySamples, difficultyTrials])
      writes.push(db.delete(table).where(eq(table.owner, job.owner)));
    writes.push(
      db.delete(resultOutbox).where(sql`${resultOutbox.matchId} in (${matchIds})`),
      db.delete(resultPlayers).where(sql`${resultPlayers.matchId} in (${matchIds})`),
      db.delete(matches).where(eq(matches.owner, job.owner)),
    );
    for (const table of [
      matchmakingSettings,
      competitions,
      questionSetItems,
      questionSets,
      questionAvailability,
      questionVersions,
      rulesetVersions,
    ])
      writes.push(db.delete(table).where(eq(table.owner, job.owner)));
    writes.push(
      db.delete(instanceGrants).where(eq(instanceGrants.instanceId, job.instanceId)),
      db
        .delete(roomMembers)
        .where(
          sql`${roomMembers.roomId} in (select ${instanceRooms.roomId} from ${instanceRooms} where ${instanceRooms.instanceId}=${job.instanceId})`,
        ),
      db.delete(instanceRooms).where(eq(instanceRooms.instanceId, job.instanceId)),
      db.delete(instances).where(eq(instances.id, job.instanceId)),
      db
        .update(jobs)
        .set({
          deletedAt: job.deletedAt ?? new Date().toISOString(),
          lastAttemptAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, operationId)),
    );
    return true;
  });
}

export async function eraseInstance(db: Database, operationId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, operationId));
  if (!job) return false;
  if (job.deletedAt) {
    const [remaining] = await db
      .select()
      .from(instances)
      .where(eq(instances.id, job.instanceId));
    if (!remaining) return true;
  }
  if (!job.acceptedAt) {
    await changeD1(db, async (writes) => {
      await requireNoRunningMatches(db, job.owner);
      await planControlEvent(db, writes, {
        version: 1,
        eventId: operationId,
        type: 'instance-deleted',
        subjectId: job.instanceId,
        createdAt: Date.now(),
      });
      writes.push(
        db
          .update(jobs)
          .set({
            acceptedAt: new Date().toISOString(),
            lastAttemptAt: new Date().toISOString(),
          })
          .where(eq(jobs.id, operationId)),
      );
    });
    return false;
  }
  const [auxiliary] = await db.all<{ pending: number }>(sql`select
    exists(select 1 from ${federationReservations} where ${federationReservations.instanceId}=${job.instanceId})
    or exists(select 1 from ${federationMetadataJobs} where ${federationMetadataJobs.instanceId}=${job.instanceId})
    or exists(select 1 from ${federationQuestionImports} where ${federationQuestionImports.instanceId}=${job.instanceId})
    or exists(select 1 from ${federationQuestionSources} where ${federationQuestionSources.instanceId}=${job.instanceId}) as pending`);
  if (auxiliary.pending) {
    await changeD1(db, async (writes) => {
      const [current] = await db.select().from(jobs).where(eq(jobs.id, operationId)),
        [instance] = await db
          .select()
          .from(instances)
          .where(eq(instances.id, job.instanceId));
      if (
        !current?.acceptedAt ||
        instance?.state !== 'archived' ||
        instance.organizationId !== job.organizationId ||
        instance.owner !== job.owner ||
        instance.name !== job.name
      )
        throw new Error('INSTANCE_DELETION_CONFLICT');
      await requireNoRunningMatches(db, job.owner);
      writes.push(
        db
          .delete(federationQuestionSources)
          .where(eq(federationQuestionSources.instanceId, job.instanceId)),
        db
          .delete(federationQuestionStaging)
          .where(
            sql`${federationQuestionStaging.importId} in (select ${federationQuestionImports.id} from ${federationQuestionImports} where ${federationQuestionImports.instanceId}=${job.instanceId})`,
          ),
        db
          .delete(federationQuestionLinks)
          .where(eq(federationQuestionLinks.instanceId, job.instanceId)),
        db
          .delete(federationQuestionImports)
          .where(eq(federationQuestionImports.instanceId, job.instanceId)),
        db.delete(federationSessions).where(sql`${federationSessions.reservationId} in
        (select ${federationReservations.id} from ${federationReservations}
          where ${federationReservations.instanceId}=${job.instanceId})`),
        db
          .delete(federationReservations)
          .where(eq(federationReservations.instanceId, job.instanceId)),
        db
          .delete(federationMetadataJobs)
          .where(eq(federationMetadataJobs.instanceId, job.instanceId)),
      );
    });
    return false;
  }
  return eraseStoredInstance(db, operationId);
}
