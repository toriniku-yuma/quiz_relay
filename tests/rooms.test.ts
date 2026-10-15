import { expect, it } from 'vitest';
import type { Command } from '../src/shared/game';
import { parseBroughtJson, validateBroughtQuestion } from '../src/shared/rooms';
import { type MatchDefinition, validateQuestion } from '../src/worker/catalog/definition';
import { dummyCharacters } from '../src/worker/game/questions';
import {
  adjudicate,
  advance,
  createState,
  snapshot,
  updateConnections,
} from '../src/worker/game/state';
import { resultFixture } from './fixtures/result';

function playing() {
  const { state } = resultFixture();
  state.matchKind = 'room';
  state.phase = 'REVEALING';
  state.result = null;
  delete state.completed;
  state.deadline = 10000;
  for (const property of state.players) property.correct = 0;
  return state;
}
function command(state: ReturnType<typeof playing>, type: Command['type']): Command {
  return {
    commandId: crypto.randomUUID(),
    matchId: state.matchId,
    questionId: state.question.id,
    type,
    payload: {},
  };
}
it('持込フォームと対戦は絵文字・結合文字の文字数境界を一致させる', () => {
  const question = validateBroughtQuestion({
    text: '問題',
    displayAnswer: '👨‍👩‍👧‍👦'.repeat(20),
    readings: ['とうきょう'],
    explanation: '😀'.repeat(300),
  });
  const fixed = {
    ...question,
    id: 'original-1',
    version: 1,
    answer: question.readings[0],
    distractors: dummyCharacters,
    source: '',
    permission: '部屋用持込',
    demoAllowed: true,
  };
  expect(validateQuestion(fixed, 4, true).explanation).toBe(question.explanation);
  expect(() =>
    validateQuestion({ ...fixed, explanation: '😀'.repeat(301) }, 4, true),
  ).toThrow('INVALID_QUESTION');
});
it('部屋は8回答者まで。ランクの上限を広げない', () => {
  const state = playing();
  const definition = {
    ...state.definition,
    rules: state.rules,
    questions: state.questions,
    playersPerMatch: 8,
    kind: 'room',
  } as MatchDefinition;
  expect(
    createState(crypto.randomUUID(), state.questions, 0, 8, true, definition).matchKind,
  ).toBe('room');
  expect(() =>
    createState(crypto.randomUUID(), state.questions, 0, 9, true, definition),
  ).toThrow('INVALID_SETUP');
  expect(() =>
    createState(crypto.randomUUID(), state.questions, 0, 8, true, {
      ...definition,
      kind: 'ranked',
    }),
  ).toThrow('INVALID_SETUP');
});
it('最後の未失格者が勝者。終端後の切断で原本・勝敗を変更しない', () => {
  const state = playing();
  state.players[1].disqualified = true;
  advance(state, 100);
  expect(state.phase).toBe('FINISHED');
  expect(state.result).toMatchObject({ reason: 'last_remaining', winnerId: 'a' });
  expect(state.completed?.players.map((property) => property.ratingDelta)).toEqual([
    0, 0,
  ]);
  const original = structuredClone(state.completed);
  updateConnections(state, new Set(), 50000);
  advance(state, 100000);
  expect(state.completed).toEqual(original);
});
it('失格なしでも誤答の加算・同問再回答禁止を維持', () => {
  const state = playing();
  state.rules.noDisqualification = true;
  state.players[0].mistakes = 99;
  expect(adjudicate(state, 'a', command(state, 'buzz'), 100).ok).toBe(true);
  const panel = state.panel;
  if (!panel) throw new Error('NO_PANEL');
  const choose = command(state, 'choose');
  choose.payload = {
    attemptId: panel.attemptId,
    panelId: panel.panelId,
    choiceId: panel.choices.find(
      (choice) => choice.text !== Array.from(state.question.answer)[0],
    )?.id,
  };
  expect(adjudicate(state, 'a', choose, 101).ok).toBe(true);
  expect(state.players[0]).toMatchObject({
    mistakes: 100,
    locked: true,
    disqualified: false,
  });
  expect(state.result).toBeNull();
});
it('問題数方式は無正解の問題も数え、指定数で引き分けを保存', () => {
  const state = playing();
  state.rules.winMode = 'questions';
  state.rules.questionLimit = 1;
  expect(state.questions.length).toBeGreaterThan(1);
  expect(snapshot(state).questionCount).toBe(1);
  state.revealed = Array.from(state.question.text).length;
  state.deadline = 100;
  advance(state, 100);
  advance(state, 100 + state.rules.judgedDisplayMs);
  expect(state.result).toMatchObject({ reason: 'question_limit', winnerId: null });
  expect(state.completed?.completedQuestions).toHaveLength(1);
  expect(snapshot(state).roomRules).toMatchObject({ winMode: 'questions', count: 1 });
  expect(snapshot(state).questionCount).toBe(1);
});
it('専任は回答・接続人数条件に含めず、接続中は次問を手動で進める', () => {
  const state = playing();
  state.players.push({ ...state.players[0], id: 'presenter', role: 'presenter' });
  expect(adjudicate(state, 'presenter', command(state, 'buzz'), 100).code).toBe(
    'PRESENTER_CANNOT_ANSWER',
  );
  state.phase = 'JUDGED';
  state.judgment = { actorId: 'a', result: 'correct' };
  state.deadline = 200;
  expect(advance(state, 201)).toBe(false);
  const next = command(state, 'next');
  expect(adjudicate(state, 'presenter', next, 201).ok).toBe(true);
  const seq = state.roomSeq;
  expect(adjudicate(state, 'presenter', next, 202).ok).toBe(true);
  expect(state.roomSeq).toBe(seq);
  updateConnections(state, new Set(['a', 'presenter']), 203);
  expect(state.reconnect).not.toBeNull();
  advance(state, 203 + state.rules.reconnectGraceMs);
  expect(state.phase).toBe('INVALID');
});
it('専任の切断時は自動進行へ移る', () => {
  const state = playing();
  state.players.push({
    ...state.players[0],
    id: 'presenter',
    role: 'presenter',
    connected: false,
  });
  state.phase = 'JUDGED';
  state.judgment = { actorId: 'a', result: 'correct' };
  state.deadline = 200;
  expect(advance(state, 201)).toBe(true);
  expect(state.questionIndex).toBe(1);
});
it('持込1問・解説省略・複数読みを受理し、不成立4択やJSON重複キーを拒否', () => {
  const question = {
    text: '日本の首都は？',
    displayAnswer: '東京',
    readings: ['とうきょう'],
  };
  expect(validateBroughtQuestion(question).explanation).toBe('');
  expect(
    parseBroughtJson(JSON.stringify({ version: 1, questions: [question] })),
  ).toHaveLength(1);
  expect(() =>
    validateBroughtQuestion({ ...question, readings: ['あ', 'い', 'う', 'え', 'お'] }),
  ).toThrow('4択');
  expect(() => parseBroughtJson('{"version":1,"version":1,"questions":[]}')).toThrow(
    '重複',
  );
});
