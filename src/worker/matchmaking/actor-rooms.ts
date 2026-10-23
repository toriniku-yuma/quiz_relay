import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { connectD1 } from '../db/d1.ts';
import { matches, roomMembers } from '../db/schema.ts';
import type { Env } from '../env.ts';
export async function actorRooms(env: Env, actor: string) {
  if (!env.GAME_D1) throw new Error('DATABASE_REQUIRED');
  const db = connectD1(env.GAME_D1);
  const games = await db
    .select({ id: matches.matchId })
    .from(matches)
    .where(
      and(
        inArray(matches.status, ['waiting', 'running']),
        sql`exists(select 1 from json_each(${matches.payload}, '$.players') where json_extract(value, '$.id')=${actor})`,
      ),
    );
  const memberships = await db
    .select({ id: roomMembers.roomId })
    .from(roomMembers)
    .where(and(eq(roomMembers.actorId, actor), gt(roomMembers.expires, Date.now())));
  return [...games.map((row) => row.id), ...memberships.map((row) => `room:${row.id}`)];
}
