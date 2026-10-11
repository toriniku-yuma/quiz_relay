import type { Investigation, MatchStatistics } from '../../shared/investigation.ts';
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
