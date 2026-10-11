import { expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { dummyCharacters, graphemes } from '../src/worker/game/questions';
import { advance, createState, snapshot } from '../src/worker/game/state';
import { questionStatistics } from '../src/worker/questions/statistics';
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

it('実績は試合単位で重複排除し、人数・世代・実力帯を混ぜない', () => {
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
  const stats = questionStatistics(
    [record, record, { ...record, kind: 'casual' }],
    'generation',
  );
  expect(stats).toHaveLength(1);
  expect(stats[0]).toMatchObject({
    trials: 1,
    correct: 1,
    participants: 2,
    band: 0,
    players: 2,
  });
  expect(questionStatistics([record], 'different-generation')).toEqual([]);
  expect(
    questionStatistics(
      [{ ...record, startingRatings: { a: 1000, b: 1800 } }],
      'generation',
    ),
  ).toEqual([]);
});

it('定期処理はDBと非公開の消去Workerの設定を必須とする', async () => {
  await expect(scheduledD1({ ORGANIZATION_ENABLED: 'true' } as Env)).rejects.toThrow(
    'MAINTENANCE_CONFIGURATION_REQUIRED',
  );
});
