import type { Player, Result } from '../../shared/game.ts';
import type { MatchDefinition } from '../catalog/definition.ts';
import type { State } from '../game/state.ts';
import { type MatchKind, ratingChange, ratingPolicy } from './rating.ts';

export type ResultRecord = {
  parentRoomId?: string;
  answerStats: State['answerStats'];
  startingRatings?: Record<string, number>;
  completedQuestions?: State['completedQuestions'];
  version: 1;
  owner: string;
  matchId: string;
  kind: MatchKind;
  startedAt: number;
  result: Result;
  definition: Omit<MatchDefinition, 'questions'>;
  ratingVersion: number;
  players: (Player & { ratingDelta: number })[];
};

export function makeResultRecord(
  state: {
    parentRoomId?: string;
    definition?: Omit<MatchDefinition, 'questions' | 'rules'>;
    rules: MatchDefinition['rules'];
    matchId: string;
    matchKind: MatchKind;
    startedAt?: number;
    players: Player[];
    completedQuestions?: State['completedQuestions'];
    startingRatings?: Record<string, number>;
    answerStats: State['answerStats'];
  },
  result: Result,
): ResultRecord | undefined {
  // 開発参加の結果は保存せず、ランキングへ入れない。
  if (state.matchKind === 'development') return;
  if (!state.definition || state.startedAt === undefined)
    throw new Error('RESULT_RECORD_INCOMPLETE');
  const kind = state.matchKind;
  return structuredClone({
    ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}),
    ...(state.startingRatings ? { startingRatings: state.startingRatings } : {}),
    ...(state.completedQuestions ? { completedQuestions: state.completedQuestions } : {}),
    answerStats: state.answerStats,
    version: 1,
    owner: state.definition.competition.owner,
    matchId: state.matchId,
    kind: state.matchKind,
    startedAt: state.startedAt,
    result,
    definition: { ...state.definition, rules: state.rules },
    ratingVersion: ratingPolicy.version,
    players: state.players.map((player) => ({
      ...player,
      ratingDelta: ratingChange(kind, result, player),
    })),
  });
}
