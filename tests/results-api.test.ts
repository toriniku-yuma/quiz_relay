import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import { contentHash } from '../src/worker/catalog/hash';
import type { Env } from '../src/worker/env';
import app from '../src/worker/index';

const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: mocks.user } }),
}));
vi.mock('../src/worker/results/read', () => ({ readResults: mocks.read }));
vi.mock('../src/worker/db/connection', () => ({
  connectDatabase: () => ({ db: {}, close: async () => {} }),
}));
beforeEach(() => {
  mocks.user.mockReset();
  mocks.read.mockReset();
  mocks.user.mockResolvedValue({
    data: { user: { id: 'self', email_confirmed_at: '2026-09-01' } },
    error: null,
  });
  mocks.read.mockResolvedValue({ history: [], ranking: [] });
});
const runtime = {
  ...(env as unknown as Env),
  ORGANIZATION_ENABLED: 'false',
  GAME_OWNER: 'https://game.test',
  GAME_DATABASE_URL: 'test',
  SUPABASE_URL: 'https://auth.test',
  SUPABASE_PUBLISHABLE_KEY: 'test',
};
const request = (headers: Record<string, string> = {}, body = '{}') =>
  app.request(
    'https://game.test/api/results/overview',
    { method: 'POST', headers: { Origin: 'https://game.test', ...headers }, body },
    runtime,
  );

it('履歴APIはOriginと正式認証を必須にする', async () => {
  expect((await request()).status).toBe(401);
  expect(
    (await request({ Authorization: 'Bearer token', Origin: 'https://other.test' }))
      .status,
  ).toBe(403);
  expect(mocks.read).not.toHaveBeenCalled();
});
it('履歴のactor・開催元をクライアント入力で変更できない', async () => {
  const response = await request(
    { Authorization: 'Bearer token' },
    JSON.stringify({ actorId: 'other', owner: 'https://other.test' }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(mocks.read).toHaveBeenCalledWith(
    {},
    runtime.GAME_OWNER,
    await contentHash({ home: runtime.GAME_OWNER, subject: 'self' }),
  );
});
it('DB停止は503。秘密やDB例外を応答へ出さない', async () => {
  mocks.read.mockRejectedValue(new Error('private database details'));
  const response = await request({ Authorization: 'Bearer token' });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 'RESULTS_UNAVAILABLE' });
});
