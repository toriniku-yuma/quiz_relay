import type { Snapshot } from './game.ts';

export type ResultsOverview = {
  actorId?: string;
  self?: { rank: number | null; rating: number };
  nextCursor?: HistoryCursor | null;
  ranking: {
    actorId: string;
    name: string;
    serverName?: string | null;
    rating: number;
    rank: number;
  }[];
  history: {
    snapshot?: Snapshot;
    parentRoomId?: string;
    kind?: 'ranked' | 'casual' | 'room' | 'development';
    questions?: {
      authorName?: string;
      id: string;
      text: string;
      displayAnswer: string;
      readings: string[];
      explanation: string;
      source: string;
    }[];
    matchId: string;
    finishedAt: string;
    reason: string;
    winnerId: string | null;
    ratingDelta: number;
    outcome: 'win' | 'loss' | 'draw' | 'invalid' | 'presenter';
    correct?: number;
    mistakes?: number;
    players: {
      disqualified?: boolean;
      forfeited?: boolean;
      guest?: boolean;
      role?: 'presenter';
      id: string;
      name: string;
      serverName?: string | null;
      correct: number;
      mistakes: number;
      ratingDelta: number;
    }[];
  }[];
};

export type HistoryEntry = ResultsOverview['history'][number];
export type HistoryCursor = { finishedAt: string; matchId: string };
export type ResultsQuery = {
  section?: 'history' | 'ranking' | 'self';
  kind?: 'ranked' | 'casual' | 'room';
  matchId?: string;
  cursor?: HistoryCursor;
};
export function resultsQuery(input: unknown): ResultsQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('INVALID_SETUP');
  const value = input as ResultsQuery;
  const id = (text: unknown): text is string =>
    typeof text === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text);
  if (
    (value.section !== undefined &&
      !['history', 'ranking', 'self'].includes(value.section)) ||
    (value.kind !== undefined && !['ranked', 'casual', 'room'].includes(value.kind)) ||
    (value.matchId !== undefined && !id(value.matchId)) ||
    (value.matchId !== undefined &&
      (value.cursor !== undefined || value.kind !== undefined)) ||
    ((value.section === 'ranking' || value.section === 'self') &&
      (value.kind !== undefined ||
        value.matchId !== undefined ||
        value.cursor !== undefined)) ||
    (value.cursor !== undefined &&
      (!value.cursor ||
        typeof value.cursor !== 'object' ||
        !id(value.cursor.matchId) ||
        typeof value.cursor.finishedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.cursor.finishedAt)) ||
        new Date(value.cursor.finishedAt).toISOString() !== value.cursor.finishedAt))
  )
    throw new Error('INVALID_SETUP');
  return {
    ...(value.section ? { section: value.section } : {}),
    ...(value.kind ? { kind: value.kind } : {}),
    ...(value.matchId ? { matchId: value.matchId } : {}),
    ...(value.cursor
      ? {
          cursor: {
            finishedAt: value.cursor.finishedAt,
            matchId: value.cursor.matchId,
          },
        }
      : {}),
  };
}

export const resultKinds = {
  ranked: 'ランクマッチ',
  casual: 'カジュアルマッチ',
  room: '部屋マッチ',
  development: '開発対戦',
};
export const resultOutcomes = {
  win: '勝利',
  loss: '敗北',
  draw: '引き分け',
  invalid: '無効試合',
  presenter: '出題専任',
};
export const resultReasons: Record<string, string> = {
  exhausted: '問題不足時の正解数で判定',
  question_limit: '指定問題数終了',
  last_remaining: '最後の未失格者が勝利',
  target_reached: '指定正解数に到達',
  connections: '復帰期限切れ',
  disqualifications: '未失格者が1人以下',
};
