import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/env';
import { failureDetails } from '../src/worker/http/diagnostics';
import { handleError } from '../src/worker/http/handlers';

it('実行環境の中断を分類し、例外本文と秘密情報は出力しない', () => {
  const error = Object.assign(
    new Error('Durable Object reset: operation canceled; secret=private-value'),
    { retryable: true, remote: true },
  );
  const details = failureDetails(error);
  expect(details).toMatchObject({
    code: 'DO_RESET',
    errorType: 'Error',
    markers: ['RESET', 'CANCELED'],
    remote: true,
    retryable: true,
    overloaded: false,
  });
  expect(JSON.stringify(details)).not.toContain('private-value');
});

it.each([
  ['Durable Object reset because its code was updated.', 'DO_CODE_UPDATED'],
  ['Durable Object is no longer active because it was replaced.', 'DO_REPLACED'],
  [
    'Durable Object storage operation exceeded timeout which caused object to be reset.',
    'DO_STORAGE_TIMEOUT',
  ],
  [
    'blockConcurrencyWhile timed out and caused the object to be reset.',
    'DO_CONCURRENCY_TIMEOUT',
  ],
])('DO障害の原因分類を区別する: %s', (message, code) => {
  const details = failureDetails(new Error(`${message} secret=private-value`));
  expect(details.code).toBe(code);
  expect(JSON.stringify(details)).not.toContain('private-value');
});

it('未知の例外でもコード位置を残し、本文・関数名・パス・URLは保存しない', () => {
  const error = new Error('private-value');
  error.stack =
    'Error: private-value\n    at private-value (index.js:123:45)\n    at run (C:\\private-value\\RoomLobby.ts:67:8)\n    at run (https://example.test/index.js?token=private-value:1:2)';
  expect(failureDetails(error).locations).toEqual([
    'index.js:123:45',
    'RoomLobby.ts:67:8',
  ]);
  expect(JSON.stringify(failureDetails(error))).not.toContain('private-value');
});

it('通常HTTPの500にも安全な発生位置を残し、応答には詳細を含めない', async () => {
  const error = new Error('Network connection lost: private-value');
  error.stack = 'Error: private-value\n    at request (index.js:123:45)';
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleError);
    app.post('/api/v1/participation/login/join', () => {
      throw error;
    });
    const response = await app.request('/api/v1/participation/login/join', {
      method: 'POST',
    });
    expect(response.status).toBe(500);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      event: 'request_failed',
      code: 'NETWORK_UNAVAILABLE',
      errorType: 'Error',
      locations: ['index.js:123:45'],
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-value');
    expect(await response.json()).toEqual({
      code: 'PROBE_FAILED',
      correlationId: expect.any(String),
    });
  } finally {
    log.mockRestore();
  }
});
