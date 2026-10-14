import { expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { dummyCharacters, graphemes } from '../src/worker/game/questions';
import { advance, createState, snapshot } from '../src/worker/game/state';
import { resultTrials } from '../src/worker/questions/difficulty-statistics';
import { scheduledD1 } from '../src/worker/scheduled';
import { resultFixture } from './fixtures/result';

it('作問者名は設定を固定し、問題終了後だけに表示する', () => {
  const { state: original, record } = resultFixture();
  const question = {
    ...original.questions[0],
    version: 1,
    distractors: [...dummyCharacters],
    source: 'source',
    permission: 'test',
    demoAllowed: true as const,
  };
  const definition = {
    ...record.definition,
    questions: [question],
    selection: {
      band: 0,
      boundaries: [1200, 1600] as [number, number],
      weights: [1, 0, 0],
      categories: {},
      revision: 1,
      authorNames: { [question.id]: '検証作問者' },
    },
  };
  const state = createState([question], 0, 2, true, definition);
  definition.selection.authorNames[question.id] = '改名後';
  state.players = structuredClone(original.players);
  state.phase = 'REVEALING';
  state.deadline = 1;
  state.revealed = graphemes(question.text).length;
  expect(JSON.stringify(snapshot(state))).not.toContain('検証作問者');
  advance(state, 2);
  expect(snapshot(state).revealedAnswer?.authorName).toBe('検証作問者');
  const hidden = createState([question], 0, 2, true, {
    ...definition,
    selection: { ...definition.selection, authorNames: {} },
  });
  expect(hidden.question.authorName).toBeUndefined();
});

it('実績は出題単位で重複排除し、ランク戦で実力帯の揃った出題だけを記録する', () => {
  const { record } = resultFixture();
  record.startingRatings = { a: 1000, b: 1000 };
  record.definition.selection = {
    band: 0,
    boundaries: [1200, 1600],
    weights: [1, 0, 0],
    categories: {},
    revision: 1,
  };
  record.completedQuestions = [
    {
      id: 'q',
      generation: 'generation',
      text: 'q',
      displayAnswer: 'a',
      readings: ['あ'],
      explanation: 'e',
      source: '',
      correct: true,
      participants: ['a', 'b'],
    },
  ];
  const [question] = record.completedQuestions;
  expect(resultTrials(record)).toEqual([
    {
      owner: record.owner,
      matchId: record.matchId,
      resultId: record.result.id,
      questionId: 'q',
      generation: 'generation',
      band: 0,
      players: 2,
      rulesHash: record.definition.rulesHash,
      bandRevision: 1,
      correct: true,
      actors: ['a', 'b'],
    },
  ]);
  expect(
    resultTrials({ ...record, completedQuestions: [question, question] }),
  ).toHaveLength(1);
  expect(resultTrials({ ...record, kind: 'casual' })).toEqual([]);
  expect(resultTrials({ ...record, startingRatings: { a: 1000, b: 1800 } })).toEqual([]);
});

it('定期処理はDBと非公開の消去Workerの設定を必須とする', async () => {
  await expect(scheduledD1({} as Env)).rejects.toThrow(
    'MAINTENANCE_CONFIGURATION_REQUIRED',
  );
});
