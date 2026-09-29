import { expect, it } from 'vitest';
import type { Command } from '../src/shared/game';
import {
  adjudicate,
  advance,
  changed,
  createState,
  updateConnections,
} from '../src/worker/game/state';
import {
  aggregateStatistics,
  resultStatistics,
} from '../src/worker/results/investigation';
import { makeResultRecord } from '../src/worker/results/record';
import { questions } from './fixtures/questions';
import { resultFixture } from './fixtures/result';

function playing() {
  const state = createState(questions, 0, 2);
  state.players = ['a', 'b'].map((id) => ({
    id,
    name: id,
    correct: 0,
    mistakes: 0,
    locked: false,
    disqualified: false,
    connected: true,
  }));
  state.phase = 'REVEALING';
  state.deadline = 10000;
  changed(state, 1000);
  return state;
}
function buzz(state: ReturnType<typeof playing>): Command {
  return {
    commandId: crypto.randomUUID(),
    matchId: state.matchId,
    questionId: state.question.id,
    type: 'buzz',
    payload: {},
  };
}
it('早押し計測から他者の解答・判定時間を除き、誤答と時間切れを分離する', () => {
  const state = playing();
  const request = buzz(state);
  expect(adjudicate(state, 'a', request, 1500).ok).toBe(true);
  expect(adjudicate(state, 'a', request, 1501).ok).toBe(true);
  advance(state, state.deadline as number);
  expect(state.answerStats).toEqual([
    { actorId: 'a', result: 'timeout', elapsedMs: 500 },
  ]);
  const resumed = state.deadline as number;
  advance(state, resumed);
  expect(adjudicate(state, 'b', buzz(state), resumed + 200).ok).toBe(true);
  expect(state.currentBuzzMs).toBe(700);
});
it('通信中断から復帰までの時間を早押し平均へ含めない', () => {
  const state = playing();
  updateConnections(state, new Set(['a']), 1200);
  updateConnections(state, new Set(['a', 'b']), 5000);
  adjudicate(state, 'b', buzz(state), 5300);
  expect(state.currentBuzzMs).toBe(500);
});
it('旧試合の未記録値をゼロ扱いせず、解答回数で重み付けした平均を集計する', () => {
  const { record } = resultFixture();
  delete record.answerStats;
  const measured = {
    ...record,
    answerStats: [
      { actorId: 'a', result: 'correct' as const, elapsedMs: 1000 },
      { actorId: 'a', result: 'correct' as const, elapsedMs: 3000 },
      { actorId: 'a', result: 'wrong' as const, elapsedMs: 600 },
      { actorId: 'a', result: 'timeout' as const, elapsedMs: 900 },
    ],
  };
  expect(resultStatistics(record, 'a').wrong).toBeNull();
  expect(resultStatistics(record, 'a').correctMs).toBeNull();
  const summary = aggregateStatistics(
    [
      record,
      measured,
      {
        ...measured,
        answerStats: [{ actorId: 'a', result: 'correct', elapsedMs: 5000 }],
      },
    ],
    'a',
  );
  expect(summary).toMatchObject({
    matches: 3,
    recordedMatches: 2,
    correctMs: 3000,
    correctSamples: 3,
    wrongMs: 600,
    wrong: 1,
    timeouts: 1,
  });
});
it('新しい試合の詳細だけを結果原本へ固定し、旧試合は未記録のまま保持する', () => {
  const { state, record } = resultFixture();
  state.answerStats = [{ actorId: 'a', result: 'correct', elapsedMs: 1000 }];
  const saved = makeResultRecord(state, record.result);
  state.answerStats[0].elapsedMs = 5000;
  expect(saved?.answerStats?.[0].elapsedMs).toBe(1000);
  delete state.answerStats;
  expect(makeResultRecord(state, record.result)).not.toHaveProperty('answerStats');
});
