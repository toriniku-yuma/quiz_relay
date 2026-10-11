import { and, desc, eq, lt } from 'drizzle-orm';
import type { Investigation } from '../../shared/investigation.ts';
import { paginationInput } from '../../shared/pagination.ts';
import { compareValues, investigationSortKeys, sortInput } from '../../shared/sorting.ts';
import { type Database, readD1 } from '../db/d1.ts';
import { matchResults, resultPlayers } from '../db/schema.ts';
import { privateResultSQL } from './privacy.ts';
import type { ResultRecord } from './record.ts';

export { aggregateStatistics, resultStatistics } from './statistics.ts';

import { aggregateStatistics, resultStatistics } from './statistics.ts';
export async function readInvestigation(
  db: Database,
  owner: string,
  actorId: string,
  resultId: string | null,
  input: Record<string, unknown>,
): Promise<Investigation> {
  const { page: requested, pageSize } = paginationInput(input);
  const sorting = sortInput(input, investigationSortKeys, 'finishedAt');
  const count = input.sample === 'all' ? null : Number(input.sample ?? 30);
  if (count !== null && (!Number.isSafeInteger(count) || count < 1))
    throw new Error('INVALID_SAMPLE');
  return readD1(db, async () => {
    const tx = db;
    const [anchor] = resultId
      ? await tx
          .select({
            payload: privateResultSQL(matchResults.payload).mapWith(
              (value) => JSON.parse(value) as ResultRecord,
            ),
            finishedAt: matchResults.finishedAt,
          })
          .from(matchResults)
          .where(and(eq(matchResults.owner, owner), eq(matchResults.resultId, resultId)))
      : [];
    if (resultId && !anchor?.payload.players.some((player) => player.id === actorId))
      throw new Error('RESULT_NOT_FOUND');
    // ponytail: 原本を直接集計。蓄積量で遅くなったらDB内の同一集計へ移す。
    const all = await tx
      .select({
        payload: privateResultSQL(matchResults.payload).mapWith(
          (value) => JSON.parse(value) as ResultRecord,
        ),
      })
      .from(matchResults)
      .innerJoin(resultPlayers, eq(resultPlayers.resultId, matchResults.resultId))
      .where(
        and(
          eq(matchResults.owner, owner),
          eq(resultPlayers.actorId, actorId),
          anchor ? lt(matchResults.finishedAt, anchor.finishedAt) : undefined,
        ),
      )
      .orderBy(desc(matchResults.finishedAt), desc(matchResults.resultId));
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
            ) || rightMatch.resultId.localeCompare(leftMatch.resultId),
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
