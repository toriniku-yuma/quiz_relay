import { and, desc, eq, lt } from 'drizzle-orm';
import type { Investigation, MatchStatistics } from '../../shared/investigation.ts';
import { paginationInput } from '../../shared/pagination.ts';
import { compareValues, investigationSortKeys, sortInput } from '../../shared/sorting.ts';
import type { connectDatabase } from '../db/connection.ts';
import { matchResults, resultPlayers } from '../db/schema.ts';
import type { ResultRecord } from './record.ts';

const average = (values: number[]) =>
  values.length
    ? values.reduce((sum, elapsedMs) => sum + elapsedMs, 0) / values.length
    : null;
export function resultStatistics(record: ResultRecord, actorId: string): MatchStatistics {
  const player = record.players.find((candidatePlayer) => candidatePlayer.id === actorId);
  if (!player) throw new Error('PLAYER_NOT_FOUND');
  const stats = record.answerStats?.filter(
    (answerStat) => answerStat.actorId === actorId,
  );
  const times = (result: 'correct' | 'wrong') =>
    stats
      ?.filter(
        (answerStat) => answerStat.result === result && answerStat.elapsedMs !== null,
      )
      .map((answerStat) => answerStat.elapsedMs as number) ?? [];
  return {
    resultId: record.result.id,
    finishedAt: new Date(record.result.finishedAt).toISOString(),
    outcome:
      player.role === 'presenter'
        ? '出題専任'
        : ['connections', 'disqualifications'].includes(record.result.reason)
          ? '無効'
          : !record.result.winnerId
            ? '引き分け'
            : record.result.winnerId === actorId
              ? '勝利'
              : '敗北',
    correct: player.correct,
    mistakes: player.mistakes,
    wrong: stats?.filter((answerStat) => answerStat.result === 'wrong').length ?? null,
    timeouts:
      stats?.filter((answerStat) => answerStat.result === 'timeout').length ?? null,
    correctMs: average(times('correct')),
    wrongMs: average(times('wrong')),
    ratingDelta: player.ratingDelta,
    players: record.players.map((participant) => ({
      name: participant.name,
      correct: participant.correct,
      mistakes: participant.mistakes,
    })),
  };
}
export function aggregateStatistics(
  records: ResultRecord[],
  actorId: string,
): Investigation['summary'] {
  const recorded = records.filter((result) => result.answerStats !== undefined),
    stats = recorded.flatMap(
      (result) =>
        result.answerStats?.filter((answerStat) => answerStat.actorId === actorId) ?? [],
    );
  const times = (result: 'correct' | 'wrong') =>
    stats
      .filter(
        (answerStat) => answerStat.result === result && answerStat.elapsedMs !== null,
      )
      .map((answerStat) => answerStat.elapsedMs as number);
  return {
    matches: records.length,
    recordedMatches: recorded.length,
    correct: records.reduce(
      (total, result) =>
        total + (result.players.find((player) => player.id === actorId)?.correct ?? 0),
      0,
    ),
    wrong: stats.filter((answerStat) => answerStat.result === 'wrong').length,
    timeouts: stats.filter((answerStat) => answerStat.result === 'timeout').length,
    correctMs: average(times('correct')),
    wrongMs: average(times('wrong')),
    correctSamples: times('correct').length,
    wrongSamples: times('wrong').length,
  };
}
export async function readInvestigation(
  db: Pick<ReturnType<typeof connectDatabase>['db'], 'transaction'>,
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
  return db.transaction(
    async (tx) => {
      const [anchor] = resultId
        ? await tx
            .select()
            .from(matchResults)
            .where(
              and(eq(matchResults.owner, owner), eq(matchResults.resultId, resultId)),
            )
        : [];
      if (resultId && !anchor?.payload.players.some((player) => player.id === actorId))
        throw new Error('RESULT_NOT_FOUND');
      // ponytail: 原本を直接集計。蓄積量で遅くなったらDB内の同一集計へ移す。
      const all = await tx
        .select({ payload: matchResults.payload })
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
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
