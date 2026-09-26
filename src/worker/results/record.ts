import type { Player, Result } from '../../shared/game';
import type { MatchDefinition } from '../catalog/definition';
import type { State } from '../game/state';
import { type MatchKind, ratingChange, ratingPolicy } from './rating';

export type ResultRecord = {
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
    definition?: Omit<MatchDefinition, 'questions' | 'rules'>;
    rules: MatchDefinition['rules'];
    matchId: string;
    matchKind?: MatchKind;
    startedAt?: number;
    players: Player[];
    completedQuestions?: State['completedQuestions'];
    startingRatings?: Record<string, number>;
  },
  result: Result,
): ResultRecord | undefined {
  // 開始時刻・種別のない旧DOと開発参加の結果を遡及してランキングへ入れない。
  if (
    !state.definition ||
    state.startedAt === undefined ||
    !state.matchKind ||
    state.matchKind === 'development'
  )
    return;
  const kind = state.matchKind;
  return structuredClone({
    ...(state.startingRatings ? { startingRatings: state.startingRatings } : {}),
    ...(state.completedQuestions ? { completedQuestions: state.completedQuestions } : {}),
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
