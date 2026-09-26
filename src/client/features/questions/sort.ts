import type { QuestionOverview, Submission } from '../../../shared/questions';

export const questionSortOptions = {
  'rate-asc': '正答率：低い順',
  'rate-desc': '正答率：高い順',
  'trials-asc': '出題回数：少ない順',
  'trials-desc': '出題回数：多い順',
  'difficulty-asc': '難易度：低い順',
  'difficulty-desc': '難易度：高い順',
  'updated-asc': '更新日時：古い順',
  'updated-desc': '更新日時：新しい順',
} as const;
export type QuestionSort = keyof typeof questionSortOptions;

export function sortQuestions(
  rows: Submission[],
  difficulties: QuestionOverview['difficulty'],
  players: number,
  band: number,
  sort: QuestionSort,
) {
  const difficultyBySeries = new Map(difficulties.map((item) => [item.seriesId, item]));
  const direction = sort.endsWith('-desc') ? -1 : 1;
  return rows
    .map((row) => {
      const difficulty = difficultyBySeries.get(row.seriesId);
      const stats =
        difficulty?.stats.filter(
          (item) => item.players === players && item.band === band,
        ) ?? [];
      const trials = stats.reduce((sum, item) => sum + item.trials, 0);
      const value = sort.startsWith('rate-')
        ? trials
          ? stats.reduce((sum, item) => sum + item.correct, 0) / trials
          : -1
        : sort.startsWith('trials-')
          ? trials
          : sort.startsWith('difficulty-')
            ? (difficulty?.current ?? row.input.difficulty)
            : Date.parse(row.updatedAt) || 0;
      return { row, value };
    })
    .sort((a, b) => (a.value - b.value) * direction)
    .map(({ row }) => row);
}
