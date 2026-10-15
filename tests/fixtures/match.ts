import { connectD1 } from '../../src/worker/db/d1';
import { matches } from '../../src/worker/db/schema';
import { commitD1Result } from '../../src/worker/results/database';
import type { ResultRecord } from '../../src/worker/results/record';

export async function runningMatchFixture(binding: D1Database, record: ResultRecord) {
  await connectD1(binding)
    .insert(matches)
    .values({
      matchId: record.matchId,
      owner: record.owner,
      parentRoomId: record.parentRoomId,
      status: 'running',
      createdAt: new Date(record.startedAt).toISOString(),
      startedAt: new Date(record.startedAt).toISOString(),
      payload: { ...record, result: null },
    })
    .onConflictDoNothing();
}

export async function commitFixtureResult(binding: D1Database, record: ResultRecord) {
  await runningMatchFixture(binding, record);
  return commitD1Result(binding, record);
}
