import type { QuestionInput } from './questions.ts';

export const QUESTION_SYNC_INTERVAL_MS = 300000;
export const QUESTION_SYNC_FRESH_MS = QUESTION_SYNC_INTERVAL_MS + 120000;

export type SharedQuestion = {
  seriesId: string;
  questionId: string;
  hash: string;
  authorId: string;
  authorName: string;
  category: { id: string; name: string };
  input: QuestionInput;
};
export type SharedQuestionPage = {
  sourceInstanceId: string;
  targetInstanceId: string;
  sourceName: string;
  snapshot: string;
  categories: { id: string; name: string }[];
  questions: SharedQuestion[];
  nextCursor: string | null;
};
export type QuestionImportConfig = {
  categories: string[];
  targetCategoryId: string;
  difficulty: Record<string, number>;
  fallback: number;
};
export type QuestionSharingOverview = {
  administrator: boolean;
  sources: { peerOrigin: string; instanceId: string; name: string; internal: boolean }[];
  sourceCategories: {
    peerOrigin: string;
    sourceInstanceId: string;
    id: string;
    name: string;
  }[];
  categories: { id: string; name: string; importOnly: boolean; revision: number }[];
  imports: {
    id: string;
    peerOrigin: string;
    sourceInstanceId: string;
    config: QuestionImportConfig;
    revision: number;
    enabled: boolean;
    syncing: boolean;
    lastSuccessAt: number;
    errorCode: string | null;
    nextAttemptAt: number;
  }[];
};
