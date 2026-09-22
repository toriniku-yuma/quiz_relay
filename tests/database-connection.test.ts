import { beforeEach, expect, it, vi } from 'vitest';
import { connectDatabase } from '../src/worker/db/connection';

const harness = vi.hoisted(() => ({ postgres: vi.fn() }));
vi.mock('postgres', () => ({ default: harness.postgres }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: () => ({}) }));
beforeEach(() => harness.postgres.mockReset().mockReturnValue({ end: vi.fn() }));
it.each(['localhost', '127.0.0.1', '[::1]'])(
  '明示したloopback %sだけで非TLS接続を許可する',
  (host) => {
    connectDatabase(
      `postgres://user:pass@${host}:55432/quiz_relay_dev?sslmode=disable`,
      'remote-ca',
    );
    expect(harness.postgres.mock.calls[0][1].ssl).toBe(false);
  },
);
it.each(['db.example.test', 'localhost.example.test', '127.0.0.2'])(
  'リモート扱いの%sではURLでTLSを無効化できない',
  (host) => {
    connectDatabase(`postgres://user:pass@${host}/db?sslmode=disable`);
    expect(harness.postgres.mock.calls[0][1].ssl).toBe('verify-full');
  },
);
it('明示指定がなければローカルでもTLS既定値を維持する', () => {
  connectDatabase('postgres://user:pass@localhost/db');
  expect(harness.postgres.mock.calls[0][1].ssl).toBe('verify-full');
});
