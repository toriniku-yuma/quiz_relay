import { and, eq, sql } from 'drizzle-orm';
import { connectD1 } from '../db/d1.ts';
import { matchResults, resultPlayers } from '../db/schema.ts';
import type { Env } from '../env.ts';

export async function rankingRating(env: Env, owner: string, actorId: string) {
  if (!env.GAME_D1) throw new Error('GAME_DATABASE_NOT_CONFIGURED');
  const db = connectD1(env.GAME_D1);
  const [row] = await db
    .select({
      rating: sql<number>`1000 + coalesce(sum(${resultPlayers.ratingDelta}), 0)`.mapWith(
        Number,
      ),
    })
    .from(resultPlayers)
    .innerJoin(matchResults, eq(matchResults.resultId, resultPlayers.resultId))
    .where(
      and(
        eq(matchResults.owner, owner),
        eq(resultPlayers.actorId, actorId),
        sql`json_extract(${matchResults.payload}, '$.kind') = 'ranked'`,
      ),
    );
  return row.rating;
}
