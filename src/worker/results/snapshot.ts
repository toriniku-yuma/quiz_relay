import type { Snapshot } from '../../shared/game.ts';
import type { ResultRecord } from './record.ts';

export function resultSnapshot(
  record: ResultRecord,
  storage: 'confirmed' | 'conflict',
): Snapshot {
  const question = record.completedQuestions?.at(-1),
    rules = record.definition.rules;
  let roomRules: Snapshot['roomRules'];
  if (record.kind === 'room') {
    if (
      !rules.winMode ||
      (rules.winMode === 'questions' && rules.questionLimit === undefined)
    )
      throw new Error('RESULT_RULES_INCOMPLETE');
    roomRules = {
      winMode: rules.winMode,
      count:
        rules.winMode === 'questions'
          ? (rules.questionLimit as number)
          : rules.correctAnswersToWin,
      mistakes: rules.noDisqualification ? null : rules.mistakesToDisqualify,
    };
  }
  return {
    kind: record.kind,
    ...(roomRules ? { roomRules } : {}),
    matchId: record.matchId,
    questionId: question?.id ?? '',
    questionNumber: record.questionNumber,
    questionCount: record.questionCount,
    text: question?.text ?? '',
    revealedAnswer: question
      ? {
          displayAnswer: question.displayAnswer,
          readings: question.readings,
          explanation: question.explanation,
          source: question.source,
          ...(question.authorName ? { authorName: question.authorName } : {}),
        }
      : null,
    roomSeq: 0,
    phase:
      record.result.reason === 'connections' ||
      record.result.reason === 'disqualifications'
        ? 'INVALID'
        : 'FINISHED',
    players: record.players.map(({ ratingDelta: _, ...player }) => ({
      ...player,
      connected: false,
    })),
    playersRequired: record.definition.playersPerMatch,
    result: { ...record.result, storage },
    reconnect: null,
    holder: null,
    showSelections: rules.showSelections,
    response: null,
    deadline: null,
    judgment: null,
  };
}
