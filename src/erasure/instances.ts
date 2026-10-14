import { and, eq, gt, isNull, sql } from 'drizzle-orm';
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
  matchmakingSettings,
  matchResults,
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
  roomDirectory,
  rulesetVersions,
  sanctionAppeals,
  userReports,
} from '../worker/db/schema.ts';
import type { Env } from '../worker/env.ts';
import { planControlEvent } from '../worker/federation/controls.ts';
import { erasureBatch } from './limits.ts';

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
          instance.state !== 'archived' ||
          !instance.roomInventoryComplete))
    )
      throw new Error('INSTANCE_DELETION_CONFLICT');
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
      roomDirectory,
      federationPolicies,
      federationMetadata,
    ])
      writes.push(db.delete(table).where(eq(table.instanceId, job.instanceId)));
    const resultIds = sql`select ${matchResults.resultId} from ${matchResults} where ${matchResults.owner}=${job.owner}`;
    for (const table of [difficultyActors, difficultySamples, difficultyTrials])
      writes.push(db.delete(table).where(eq(table.owner, job.owner)));
    writes.push(
      db.delete(resultOutbox).where(sql`${resultOutbox.resultId} in (${resultIds})`),
      db.delete(resultPlayers).where(sql`${resultPlayers.resultId} in (${resultIds})`),
      db.delete(matchResults).where(eq(matchResults.owner, job.owner)),
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
      db.delete(instanceRooms).where(eq(instanceRooms.instanceId, job.instanceId)),
      db.delete(instances).where(eq(instances.id, job.instanceId)),
      db
        .update(jobs)
        .set({
          deletedAt: job.deletedAt ?? new Date().toISOString(),
          inventoryPending: false,
          lastAttemptAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, operationId)),
    );
    return true;
  });
}

export async function eraseInstance(
  db: Database,
  rooms: Env['GAME_ROOM'],
  operationId: string,
) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, operationId));
  if (!job) return false;
  if (job.deletedAt && !job.inventoryPending) return true;
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(jobs)
        .set({ lastAttemptAt: new Date().toISOString() })
        .where(eq(jobs.id, operationId)),
    );
  });
  if (!job.acceptedAt && !job.deletedAt) {
    const checking = await db
      .select()
      .from(instanceRooms)
      .where(
        and(
          eq(instanceRooms.instanceId, job.instanceId),
          job.checkCursor ? gt(instanceRooms.roomId, job.checkCursor) : undefined,
        ),
      )
      .orderBy(instanceRooms.roomId)
      .limit(erasureBatch.rooms);
    for (const row of checking) {
      const status = await rooms
        .get(rooms.idFromString(row.roomId))
        .deletionStatus(job.instanceId);
      if (!status.safe) {
        await changeD1(db, async (writes) => {
          writes.push(
            db.delete(jobs).where(and(eq(jobs.id, job.id), isNull(jobs.acceptedAt))),
          );
        });
        throw new Error('RESULT_OR_MATCH_PENDING');
      }
    }
    await changeD1(db, async (writes) => {
      const [current] = await db.select().from(jobs).where(eq(jobs.id, operationId));
      if (!current || current.checkCursor !== job.checkCursor) return;
      if (!current.acceptedAt && checking.length < erasureBatch.rooms)
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
            ...(checking.length
              ? { checkCursor: checking[checking.length - 1].roomId }
              : {}),
            ...(checking.length < erasureBatch.rooms
              ? { acceptedAt: new Date().toISOString() }
              : {}),
          })
          .where(eq(jobs.id, job.id)),
      );
    });
    return false;
  }
  const registered = await db
    .select()
    .from(instanceRooms)
    .where(
      and(
        eq(instanceRooms.instanceId, job.instanceId),
        job.roomCursor ? gt(instanceRooms.roomId, job.roomCursor) : undefined,
      ),
    )
    .orderBy(instanceRooms.roomId)
    .limit(erasureBatch.rooms);
  for (const row of registered) {
    const room = rooms.get(rooms.idFromString(row.roomId));
    if (job.deletedAt)
      await room.eraseRestoredInstance({
        id: job.instanceId,
        owner: job.owner,
        deletedAt: job.deletedAt,
      });
    else {
      const result = await room.eraseInstance(job.instanceId);
      if (!result.ok) throw new Error(result.code);
    }
  }
  if (registered.length)
    await changeD1(db, async (writes) => {
      const [current] = await db.select().from(jobs).where(eq(jobs.id, operationId));
      if (current && current.roomCursor === job.roomCursor && registered.length)
        writes.push(
          db
            .update(jobs)
            .set({ roomCursor: registered[registered.length - 1].roomId })
            .where(eq(jobs.id, operationId)),
        );
    });
  if (registered.length === erasureBatch.rooms) return false;
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
        !instance.roomInventoryComplete ||
        instance.organizationId !== job.organizationId ||
        instance.owner !== job.owner ||
        instance.name !== job.name
      )
        throw new Error('INSTANCE_DELETION_CONFLICT');
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
