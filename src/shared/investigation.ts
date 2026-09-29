import type { Pagination } from './pagination';
export type MatchStatistics = {
  resultId: string;
  finishedAt: string;
  outcome: string;
  correct: number;
  mistakes: number;
  wrong: number | null;
  timeouts: number | null;
  correctMs: number | null;
  wrongMs: number | null;
  ratingDelta: number;
  players: { name: string; correct: number; mistakes: number }[];
};
export type Investigation = {
  reported: MatchStatistics | null;
  rows: MatchStatistics[];
  pagination: Pagination;
  summary: {
    matches: number;
    recordedMatches: number;
    correct: number;
    wrong: number;
    timeouts: number;
    correctMs: number | null;
    wrongMs: number | null;
    correctSamples: number;
    wrongSamples: number;
  };
};
