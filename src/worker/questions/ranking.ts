import { and, eq, sql } from 'drizzle-orm';
import { connectDatabase } from '../db/connection.ts';
import { matchResults, resultPlayers } from '../db/schema.ts';
import type { Env } from '../env';

export async function rankingRating(env: Env, owner: string, actorId: string) {
  const binding = env.GAME_HYPERDRIVE;
  const address = binding?.connectionString ?? env.GAME_DATABASE_URL;
  if (!address) throw new Error('GAME_DATABASE_NOT_CONFIGURED');
  const { db, close } = connectDatabase(address, env.DATABASE_CA_CERT, !!binding);
  try {
    const [row] = await db
      .select({
        rating:
          sql<number>`1000 + coalesce(sum(${resultPlayers.ratingDelta}), 0)`.mapWith(
            Number,
          ),
      })
      .from(resultPlayers)
      .innerJoin(matchResults, eq(matchResults.resultId, resultPlayers.resultId))
      .where(
        and(
          eq(matchResults.owner, owner),
          eq(resultPlayers.actorId, actorId),
          sql`${matchResults.payload}->>'kind' = 'ranked'`,
        ),
      );
    return row.rating;
  } finally {
    await close();
  }
}
export async function rankingBand(
  env: Env,
  owner: string,
  actorId: string,
  boundaries: [number, number] = [1200, 1600],
) {
  const rating = await rankingRating(env, owner, actorId);
  return rating < boundaries[0] ? 0 : rating < boundaries[1] ? 1 : 2;
}
