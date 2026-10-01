import { assert, expect, it } from 'vitest';
import { anonymizeState, expireReview, reviewDeadline } from '../src/worker/game/privacy';
import { snapshot } from '../src/worker/game/state';
import { withdrawAccount } from '../src/worker/organization/withdrawal';
import { resultFixture } from './fixtures/result';

it('確認後にログインアカウントが変わった退会要求はDB操作前に拒否する', async () => {
  await expect(
    withdrawAccount(
      {} as Parameters<typeof withdrawAccount>[0],
      {} as Parameters<typeof withdrawAccount>[1],
      'new-user',
      { subject: 'old-user', confirmation: '退会', operationId: crypto.randomUUID() },
    ),
  ).rejects.toThrow('WITHDRAWAL_ACCOUNT_CHANGED');
});

it('365日期限で部屋内の問題・答え・同期キャッシュを消し、未保存結果は保全する', () => {
  const { state } = resultFixture();
  assert(state.result && state.completed);
  const now = state.result.finishedAt + 365 * 86400000;
  expect(expireReview(state, now)).toBe(false);
  state.result.storage = 'confirmed';
  expect(reviewDeadline(state)).toBe(now);
  expect(expireReview(state, now - 1)).toBe(false);
  const players = structuredClone(state.completed.players);
  const result = structuredClone(state.result);
  state.publicState = snapshot(state);
  expect(expireReview(state, now)).toBe(true);
  expect(state.questions).toEqual([]);
  expect(state.question.text).toBe('');
  expect(state.completedQuestions).toBeUndefined();
  expect(state.completed.completedQuestions).toBeUndefined();
  expect(state.publicState).toBeNull();
  expect(state.result).toEqual(result);
  expect(state.completed.players).toEqual(players);
  expect(reviewDeadline(state)).toBeUndefined();
});

it('退会者のIDで名前を消去し、同名の相手・問題本文・結果・レートを保持する', () => {
  const { state } = resultFixture();
  const beforeResult = structuredClone(state.result);
  const beforeText = state.question.text;
  for (const player of state.players) player.name = '同じ旧名';
  if (state.completed)
    for (const player of state.completed.players) player.name = '同じ旧名';
  state.question.authorName = '同じ旧名';
  const id = state.question.id;
  if (state.definition)
    state.definition.selection = {
      band: 0,
      boundaries: [1200, 1600],
      weights: [1, 0, 0],
      categories: {},
      revision: 1,
      authorNames: { [id]: '同じ旧名', unrelated: '同じ旧名' },
    };
  state.publicState = snapshot(state);
  state.events = [
    {
      roomSeq: state.roomSeq,
      at: Date.now(),
      changes: { players: structuredClone(state.players) },
    },
  ];
  const deltas = state.completed?.players.map((player) => player.ratingDelta);
  anonymizeState(state, 'a', new Set([id]));
  expect(state.players.map((player) => player.name)).toEqual([
    '退会ユーザー',
    '同じ旧名',
  ]);
  expect(state.completed?.players.map((player) => player.name)).toEqual([
    '退会ユーザー',
    '同じ旧名',
  ]);
  expect(state.completed?.players.map((player) => player.ratingDelta)).toEqual(deltas);
  expect(state.question.authorName).toBe('退会ユーザー');
  expect(state.question.text).toBe(beforeText);
  expect(state.definition?.selection?.authorNames).toEqual({
    [id]: '退会ユーザー',
    unrelated: '同じ旧名',
  });
  expect(state.result).toEqual(beforeResult);
  expect(state.events).toEqual([]);
  expect(state.publicState).toBeNull();
});
