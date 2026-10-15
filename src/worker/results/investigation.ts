import { and, desc, eq, lt } from 'drizzle-orm';
import type { Investigation } from '../../shared/investigation.ts';
import { paginationInput } from '../../shared/pagination.ts';
import { compareValues, investigationSortKeys, sortInput } from '../../shared/sorting.ts';
import { type Database, readD1 } from '../db/d1.ts';
import { matches, resultPlayers } from '../db/schema.ts';
import { privateResultSQL } from './privacy.ts';
import type { ResultRecord } from './record.ts';

export { aggregateStatistics, resultStatistics } from './statistics.ts';

import { aggregateStatistics, resultStatistics } from './statistics.ts';
export async function readInvestigation(
  db: Database,
  owner: string,
  actorId: string,
  matchId: string | null,
  input: Record<string, unknown>,
): Promise<Investigation> {
  const { page: requested, pageSize } = paginationInput(input);
  const sorting = sortInput(input, investigationSortKeys, 'finishedAt');
  const count = input.sample === 'all' ? null : Number(input.sample ?? 30);
  if (count !== null && (!Number.isSafeInteger(count) || count < 1))
    throw new Error('INVALID_SAMPLE');
  return readD1(db, async () => {
    const tx = db;
    const [anchor] = matchId
      ? await tx
          .select({
            payload: privateResultSQL(matches.payload).mapWith(
              (value) => JSON.parse(value) as ResultRecord,
            ),
            finishedAt: matches.finishedAt,
          })
          .from(matches)
          .where(and(eq(matches.owner, owner), eq(matches.matchId, matchId)))
      : [];
    if (
      matchId &&
      (!anchor?.payload.result ||
        !anchor.payload.players.some((player) => player.id === actorId))
    )
      throw new Error('RESULT_NOT_FOUND');
    // ponytail: 原本を直接集計。蓄積量で遅くなったらDB内の同一集計へ移す。
    const all = await tx
      .select({
        payload: privateResultSQL(matches.payload).mapWith(
          (value) => JSON.parse(value) as ResultRecord,
        ),
      })
      .from(matches)
      .innerJoin(resultPlayers, eq(resultPlayers.matchId, matches.matchId))
      .where(
        and(
          eq(matches.owner, owner),
          eq(resultPlayers.actorId, actorId),
          anchor?.finishedAt ? lt(matches.finishedAt, anchor.finishedAt) : undefined,
        ),
      )
      .orderBy(desc(matches.finishedAt), desc(matches.matchId));
    const page = Math.min(requested, Math.max(1, Math.ceil(all.length / pageSize)));
    return {
      reported: anchor ? resultStatistics(anchor.payload, actorId) : null,
      rows: all
        .map((result) => resultStatistics(result.payload, actorId))
        .sort(
          (leftMatch, rightMatch) =>
            compareValues(
              leftMatch[sorting.sort as (typeof investigationSortKeys)[number]],
              rightMatch[sorting.sort as (typeof investigationSortKeys)[number]],
              sorting.direction,
            ) || rightMatch.matchId.localeCompare(leftMatch.matchId),
        )
        .slice((page - 1) * pageSize, page * pageSize),
      pagination: { page, pageSize, total: all.length },
      summary: aggregateStatistics(
        (count === null ? all : all.slice(0, count)).map((result) => result.payload),
        actorId,
      ),
    };
  });
}
