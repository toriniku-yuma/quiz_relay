import { expect, it } from 'vitest';
import defaults from '../config/matchmaking.json';
import local from '../config/matchmaking.local.json';
import { validateMatchConfig } from '../src/worker/catalog/config';
import { adjudicate, createState } from '../src/worker/game/state';
import { questions } from './fixtures/questions';

it('JSON profiles validate and allow changing players, win target, mistakes and grace', () => {
  expect(validateMatchConfig(defaults).playersPerMatch).toBe(4);
  expect(validateMatchConfig(local).playersPerMatch).toBe(2);
  const next = validateMatchConfig({
    ...local,
    playersPerMatch: 3,
    rules: {
      ...local.rules,
      correctAnswersToWin: 1,
      mistakesToDisqualify: 2,
      reconnectGraceMs: 20000,
    },
  });
  expect(next.rules.correctAnswersToWin).toBe(1);
  expect(next.rules.mistakesToDisqualify).toBe(2);
  expect(next.rules.reconnectGraceMs).toBe(20000);
});
it.each([1, 5, '2', null])('refuses unsupported player setting %s', (playersPerMatch) => {
  expect(() => validateMatchConfig({ ...local, playersPerMatch })).toThrow();
});
it('rejects misspelled keys, incomplete rules and invalid durations before applying', () => {
  expect(() => validateMatchConfig({ ...local, players: 2 })).toThrow();
  expect(() => validateMatchConfig({ ...local, rules: { choiceCount: 4 } })).toThrow();
  expect(() =>
    validateMatchConfig({ ...local, rules: { ...local.rules, reconnectGraceMs: 0 } }),
  ).toThrow();
});
it('changed win target determines adjudication while an older state keeps its own rules', () => {
  const old = createState(questions, 0, 2);
  const state = createState(questions, 0, 2);
  state.rules = { ...local.rules, correctAnswersToWin: 1 };
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
  state.deadline = 100000;
  const command = (type: 'buzz' | 'choose', payload: Record<string, string> = {}) => ({
    commandId: crypto.randomUUID(),
    matchId: state.matchId,
    questionId: state.question.id,
    type,
    payload,
  });
  expect(adjudicate(state, 'a', command('buzz'), 100).ok).toBe(true);
  for (const letter of ['に', 'じ']) {
    const panel = state.panel;
    if (!panel) throw Error('panel');
    const choice = panel.choices.find((choice) => choice.text === letter);
    if (!choice) throw Error('choice');
    expect(
      adjudicate(
        state,
        'a',
        command('choose', {
          attemptId: panel.attemptId,
          panelId: panel.panelId,
          choiceId: choice.id,
        }),
        200,
      ).ok,
    ).toBe(true);
  }
  expect(state.phase).toBe('FINISHED');
  expect(state.result?.reason).toBe('target_reached');
  expect(old.rules.correctAnswersToWin).toBe(7);
});
