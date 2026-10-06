import { eq, sql } from 'drizzle-orm';
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
  source: ResultRecord,
) {
  await db.transaction(async (tx) => {
    const [{ record }] = await tx.execute<{ record: ResultRecord }>(
      sql`select quiz_game.private_result(${JSON.stringify(source)}::jsonb) as record`,
    );
    const hash = await contentHash(record);
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
        .select({
          hash: matchResults.payloadHash,
          payload: matchResults.payload,
          normalized: sql<ResultRecord>`quiz_game.private_result(${matchResults.payload})`,
          source: sql<ResultRecord>`quiz_game.private_result(${JSON.stringify(source)}::jsonb)`,
          outboxHash: resultOutbox.payloadHash,
          outboxPayload: resultOutbox.payload,
          outboxNormalized: sql<ResultRecord>`quiz_game.private_result(${resultOutbox.payload})`,
          players: sql<
            { actorId: string; name: string; ratingDelta: number }[]
          >`coalesce((
            select jsonb_agg(jsonb_build_object('actorId', ${resultPlayers.actorId}, 'name', ${resultPlayers.name}, 'ratingDelta', ${resultPlayers.ratingDelta}))
            from ${resultPlayers} where ${resultPlayers.resultId} = ${matchResults.resultId}
          ), '[]'::jsonb)`,
        })
        .from(matchResults)
        .leftJoin(resultOutbox, eq(resultOutbox.resultId, matchResults.resultId))
        .where(eq(matchResults.resultId, record.result.id));
      // One statement keeps withdrawal/physical anonymization from mixing snapshots.
      if (
        !existing?.outboxPayload ||
        existing.hash !== (await contentHash(existing.payload)) ||
        existing.outboxHash !== (await contentHash(existing.outboxPayload)) ||
        (await contentHash(existing.normalized)) !==
          (await contentHash(existing.source)) ||
        (await contentHash(existing.outboxNormalized)) !==
          (await contentHash(existing.source))
      )
        throw new ResultConflict();
      const byActor = (
        leftPlayer: { actorId: string },
        rightPlayer: { actorId: string },
      ) => leftPlayer.actorId.localeCompare(rightPlayer.actorId);
      if (
        (await contentHash(existing.players.sort(byActor))) !==
        (await contentHash(
          existing.payload.players
            .map((player) => ({
              actorId: player.id,
              name: player.name,
              ratingDelta: player.ratingDelta,
            }))
            .sort(byActor),
        ))
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
