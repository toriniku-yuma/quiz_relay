import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { connectDatabase } from '../worker/db/connection.ts';
import {
  instanceRooms,
  instances,
  accountWithdrawals as jobs,
  matchResults,
  questionSubmissions,
  questionVersions,
} from '../worker/db/schema.ts';
import type { Env } from '../worker/env.ts';
import { erasureBatch } from './limits.ts';
import { eraseResultNames } from './results.ts';

type Database = Pick<ReturnType<typeof connectDatabase>['db'], 'transaction' | 'update'>;
export async function anonymizeWithdrawal(
  db: Database,
  env: Pick<Env, 'GAME_ROOM' | 'MATCHMAKER'>,
  id: string,
) {
  await db
    .update(jobs)
    .set({ lastAttemptAt: new Date().toISOString() })
    .where(eq(jobs.id, id));
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`anonymize:${id}`},0))`,
    );
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, id));
    if (!job || job.erasedAt) return true;
    const matchmaker = env.MATCHMAKER.getByName(job.organizationId);
    await matchmaker.beginWithdrawal(job.actorId, job.id);
    await matchmaker.logoutActor(job.actorId);
    const scopes = await tx
      .select()
      .from(instances)
      .where(eq(instances.organizationId, job.organizationId));
    await eraseResultNames(tx);
    await tx.execute(sql`select quiz_game.erase_author_catalogs()`);
    await tx.execute(sql`select quiz_game.erase_withdrawal_audit(${job.id}::uuid)`);
    // A restored/legacy inventory must finish before a cursor can cover all old rooms.
    if (scopes.some((scope) => !scope.roomInventoryComplete)) {
      await tx.update(jobs).set({ roomCursor: null }).where(eq(jobs.id, id));
      return false;
    }
    const authored = await tx
      .select({
        id: questionSubmissions.id,
        seriesId: questionSubmissions.seriesId,
        publishedId: questionSubmissions.publishedId,
      })
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
    const versions = await tx
      .select({
        id: questionVersions.questionId,
        seriesId: sql<string>`${questionVersions.payload}->>'seriesId'`,
      })
      .from(questionVersions)
      .innerJoin(instances, eq(instances.owner, questionVersions.owner))
      .where(eq(instances.organizationId, job.organizationId));
    for (const version of versions) if (ids.has(version.seriesId)) ids.add(version.id);
    const rooms = await tx
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
    if (rooms.length)
      await tx
        .update(jobs)
        .set({ roomCursor: rooms[rooms.length - 1].roomId })
        .where(eq(jobs.id, id));
    if (rooms.length === erasureBatch.rooms) return false;
    await matchmaker.anonymizeAccount(job.actorId, [...ids]);
    const remaining = await tx
      .select({ id: matchResults.resultId })
      .from(matchResults)
      .where(
        sql`${matchResults.payload} IS DISTINCT FROM quiz_game.private_result(${matchResults.payload})`,
      )
      .limit(1);
    if (remaining.length || !job.authDeletedAt) return false;
    await tx
      .update(jobs)
      .set({ erasedAt: new Date().toISOString() })
      .where(and(eq(jobs.id, id), isNotNull(jobs.authDeletedAt)));
    return true;
  });
}
