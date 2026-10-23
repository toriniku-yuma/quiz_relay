import { expect, it } from 'vitest';
import { failureCode } from '../src/worker/http/diagnostics';

it('DB原因を辿って固定コードだけを返し、SQLや秘密を含む例外を公開しない', () => {
  const database = new Error('D1_ERROR: UNIQUE constraint failed: table.id');
  expect(
    failureCode(new Error('Failed query: secret SQL and bindings', { cause: database })),
  ).toBe('D1_UNIQUE');
  expect(
    failureCode(
      new Error(
        'D1_ERROR: Wrong number of parameter bindings for SQL query. Expected 9 got 3.',
      ),
    ),
  ).toBe('D1_BINDINGS');
  expect(failureCode(new Error('D1_ERROR: no such column: source_actor_id'))).toBe(
    'D1_MISSING_COLUMN_SOURCE_ACTOR_ID',
  );
  expect(
    failureCode(new Error('secret token=private question and email@example.com')),
  ).toBe('INTERNAL');
});
