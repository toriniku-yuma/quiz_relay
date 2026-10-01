import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { connectDatabase } from '../worker/db/connection.ts';
import { instanceRooms, instanceDeletions as jobs } from '../worker/db/schema.ts';
import type { Env } from '../worker/env.ts';
import { erasureBatch } from './limits.ts';

type Database = Pick<
  ReturnType<typeof connectDatabase>['db'],
  'select' | 'transaction' | 'update'
>;
export async function eraseInstance(
  db: Database,
  rooms: Env['GAME_ROOM'],
  operationId: string,
) {
  await db
    .update(jobs)
    .set({ lastAttemptAt: new Date().toISOString() })
    .where(eq(jobs.id, operationId));
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`erase-instance:${operationId}`},0))`,
    );
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, operationId));
    if (!job) return false;
    if (!job.acceptedAt && !job.deletedAt) {
      const checking = await tx
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
          // A rejected check never authorizes a later automatic deletion.
          await tx.delete(jobs).where(and(eq(jobs.id, job.id), isNull(jobs.acceptedAt)));
          return 'blocked' as const;
        }
      }
      if (checking.length)
        await tx
          .update(jobs)
          .set({ checkCursor: checking[checking.length - 1].roomId })
          .where(eq(jobs.id, job.id));
      if (checking.length === erasureBatch.rooms) return false;
      await tx
        .update(jobs)
        .set({ acceptedAt: new Date().toISOString() })
        .where(eq(jobs.id, job.id));
    }
    const registered = await tx
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
      await tx
        .update(jobs)
        .set({ roomCursor: registered[registered.length - 1].roomId })
        .where(eq(jobs.id, job.id));
    if (registered.length === erasureBatch.rooms) return false;
    await tx.execute(sql`select quiz_game.erase_instance(${job.id}::uuid)`);
    return true;
  });
  if (outcome === 'blocked') throw new Error('RESULT_OR_MATCH_PENDING');
  return outcome;
}

export async function retryInstanceDeletions(db: Database, rooms: Env['GAME_ROOM']) {
  const due = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(isNull(jobs.deletedAt))
    .orderBy(jobs.lastAttemptAt, jobs.requestedAt)
    .limit(erasureBatch.jobs);
  let failed = false;
  for (const job of due)
    try {
      await eraseInstance(db, rooms, job.id);
    } catch {
      failed = true;
    }
  if (failed) throw new Error('INSTANCE_ERASURE_INCOMPLETE');
}
