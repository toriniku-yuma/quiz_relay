import { eq } from 'drizzle-orm';
import { contentHash } from '../catalog/hash.ts';
import { connectDatabase } from '../db/connection.ts';
import { matchResults, resultOutbox, resultPlayers } from '../db/schema.ts';
import type { Env } from '../env';
import type { ResultRecord } from './record';

export class ResultConflict extends Error {
  constructor() {
    super('RESULT_CONFLICT');
  }
}

export async function commitResult(
  db: Pick<ReturnType<typeof connectDatabase>['db'], 'transaction'>,
  record: ResultRecord,
) {
  const hash = await contentHash(record);
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(matchResults)
      .values({
        resultId: record.result.id,
        owner: record.owner,
        matchId: record.matchId,
        finishedAt: new Date(record.result.finishedAt).toISOString(),
        payloadHash: hash,
        payload: record,
      })
      .onConflictDoNothing()
      .returning({ id: matchResults.resultId });
    if (!inserted.length) {
      const [existing] = await tx
        .select({ hash: matchResults.payloadHash })
        .from(matchResults)
        .where(eq(matchResults.resultId, record.result.id));
      const [outbox] = await tx
        .select({ hash: resultOutbox.payloadHash })
        .from(resultOutbox)
        .where(eq(resultOutbox.resultId, record.result.id));
      if (existing?.hash !== hash || outbox?.hash !== hash) throw new ResultConflict();
      const players = await tx
        .select({
          actorId: resultPlayers.actorId,
          name: resultPlayers.name,
          ratingDelta: resultPlayers.ratingDelta,
        })
        .from(resultPlayers)
        .where(eq(resultPlayers.resultId, record.result.id));
      const expected = record.players.map((player) => ({
        actorId: player.id,
        name: player.name,
        ratingDelta: player.ratingDelta,
      }));
      const byActor = (a: { actorId: string }, b: { actorId: string }) =>
        a.actorId.localeCompare(b.actorId);
      if (
        (await contentHash(players.sort(byActor))) !==
        (await contentHash(expected.sort(byActor)))
      )
        throw new ResultConflict();
      return;
    }
    await tx.insert(resultPlayers).values(
      record.players.map((player) => ({
        resultId: record.result.id,
        actorId: player.id,
        name: player.name,
        ratingDelta: player.ratingDelta,
      })),
    );
    await tx
      .insert(resultOutbox)
      .values({ resultId: record.result.id, payloadHash: hash, payload: record });
  });
}

export async function saveResult(env: Env, record: ResultRecord) {
  if (record.owner !== env.GAME_OWNER) throw new ResultConflict();
  const binding = env.RESULT_HYPERDRIVE;
  const url = binding?.connectionString ?? env.RESULT_DATABASE_URL;
  if (!url) throw new Error('RESULT_DATABASE_NOT_CONFIGURED');
  const { db, close } = connectDatabase(url, env.DATABASE_CA_CERT, !!binding);
  try {
    await commitResult(db, record);
  } finally {
    await close();
  }
}
