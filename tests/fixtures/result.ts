import type { Result } from '../../src/shared/game';
import { createState } from '../../src/worker/game/state';
import { makeResultRecord } from '../../src/worker/results/record';
import { questions } from './questions';

export function resultFixture() {
  const state = createState(crypto.randomUUID(), questions, 0, 2);
  state.matchKind = 'ranked';
  state.startedAt = Date.now() - 1000;
  state.definition = {
    competition: { owner: 'https://game.test', id: 'demo', version: 1 },
    ruleset: { owner: 'https://game.test', id: 'standard', version: 1 },
    questionSet: { owner: 'https://game.test', id: 'questions', version: 1 },
    rulesHash: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
    playersPerMatch: 2,
  };
  state.players = ['a', 'b'].map((id) => ({
    id,
    name: id.toUpperCase(),
    correct: id === 'a' ? 7 : 0,
    mistakes: 0,
    locked: false,
    disqualified: false,
    connected: true,
  }));
  const result: Result = {
    reason: 'target_reached',
    winnerId: 'a',
    finishedAt: Date.now(),
  };
  const record = makeResultRecord(state, result);
  if (!record) throw new Error('NO_RECORD');
  state.result = { ...result, storage: 'pending' };
  state.completed = record;
  state.phase = 'FINISHED';
  return { state, record };
}
