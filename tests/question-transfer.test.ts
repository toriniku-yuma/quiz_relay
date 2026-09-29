import { expect, it } from 'vitest';
import { exportTransfer, parseTransfer } from '../src/shared/question-transfer';
import { emptyQuestion } from '../src/shared/questions';

it('移行JSONは未完成の問題・来歴・停止状態を保ち、500件ごとに分割する', () => {
  const row = {
    input: { ...emptyQuestion(), readings: [] },
    category: '',
    stopped: true,
    provenance: { author: '元作問者', instance: '元インスタンス' },
  };
  const files = exportTransfer(Array.from({ length: 501 }, () => row));
  expect(files.length).toBe(2);
  expect(parseTransfer(files[0])).toHaveLength(500);
  expect(parseTransfer(files[1])).toEqual([row]);
  expect(files.join('')).not.toContain('authorId');
});
it('不正な移行JSONと重複キーを拒否する', () => {
  expect(() => parseTransfer('{"version":2,"version":2,"questions":[]}')).toThrow();
  expect(() =>
    parseTransfer(
      JSON.stringify({
        version: 2,
        questions: [
          {
            input: emptyQuestion(),
            category: 'x',
            stopped: 'false',
            provenance: { author: 'a', instance: 'b' },
          },
        ],
      }),
    ),
  ).toThrow();
});
