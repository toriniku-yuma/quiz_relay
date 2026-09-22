import { expect, it } from 'vitest';
import config from '../config/matchmaking.json';
import { validateCatalogOperation } from '../src/worker/catalog/manage';
import { questions } from './fixtures/questions';

const owner = config.owner;
const question = questions[0];
it('管理操作は新規IDの改訂・順序付きセット・開催元の一致を検証する', () => {
  expect(
    validateCatalogOperation({ operation: 'register', question }, owner),
  ).toMatchObject({ operation: 'register', question });
  expect(
    validateCatalogOperation(
      {
        operation: 'revise',
        questionId: question.id,
        question: { ...question, id: 'revision' },
      },
      owner,
    ),
  ).toMatchObject({ operation: 'revise' });
  expect(
    validateCatalogOperation(
      { operation: 'set', setId: 'set', questionIds: ['b', 'a'] },
      owner,
    ),
  ).toMatchObject({ questionIds: ['b', 'a'] });
  expect(
    validateCatalogOperation({ operation: 'configure', profile: 'test', config }, owner),
  ).toMatchObject({ operation: 'configure' });
});
it.each([
  { operation: 'register', question: { ...question, version: 2 } },
  { operation: 'register', question: { ...question, unknown: true } },
  { operation: 'register', question: { ...question, demoAllowed: false } },
  { operation: 'register', question: { ...question, answer: '' } },
  { operation: 'register', question: { ...question, distractors: [] } },
  { operation: 'revise', questionId: question.id, question },
  { operation: 'retire', questionId: '../a' },
  { operation: 'retire', questionId: 'a', owner: 'https://other.test' },
  { operation: 'set', setId: 'set', questionIds: [] },
  { operation: 'set', setId: 'set', questionIds: ['a', 'a'] },
  {
    operation: 'set',
    setId: 'set',
    questionIds: Array.from({ length: 101 }, (_, i) => `q${i}`),
  },
  {
    operation: 'configure',
    profile: 'test',
    config: { ...config, owner: 'https://other.test' },
  },
  { operation: 'delete', questionId: 'a' },
])('不正な管理入力を拒否する: %j', (input) => {
  expect(() => validateCatalogOperation(input, owner)).toThrow();
});
