import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import { contentHash } from '../src/worker/catalog/hash';
import type { Env } from '../src/worker/env';
import app from '../src/worker/index';

const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: mocks.user,
      getClaims: async () => ({
        data: {
          claims: { sub: (await mocks.user()).data.user?.id, amr: [{ method: 'oauth' }] },
        },
        error: null,
      }),
    },
  }),
}));
vi.mock('../src/worker/results/read', () => ({ readResults: mocks.read }));
vi.mock('../src/worker/db/d1', () => ({
  connectD1: () => ({}),
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
    [],
    {},
  );
});
it('DB停止は503。秘密やDB例外を応答へ出さない', async () => {
  mocks.read.mockRejectedValue(new Error('private database details'));
  const response = await request({ Authorization: 'Bearer token' });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 'RESULTS_UNAVAILABLE' });
});

it('本人順位も入力のactor・開催元を使わず、認証された本人だけを取得する', async () => {
  mocks.read.mockResolvedValue({
    ranking: [],
    history: [],
    self: { rank: 104, rating: 980 },
  });
  const response = await request(
    { Authorization: 'Bearer token' },
    JSON.stringify({
      section: 'self',
      actorId: 'other',
      owner: 'https://other.test',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ranking: [],
    history: [],
    self: { rank: 104, rating: 980 },
  });
  expect(mocks.read).toHaveBeenLastCalledWith(
    {},
    runtime.GAME_OWNER,
    await contentHash({ home: runtime.GAME_OWNER, subject: 'self' }),
    [],
    { section: 'self' },
  );
});

it('履歴の種別・追加取得・詳細指定は本人の読取へだけ渡す', async () => {
  const cursor = {
    finishedAt: '2026-10-01T00:00:00.000Z',
    resultId: crypto.randomUUID(),
  };
  for (const query of [
    { section: 'history', kind: 'casual', cursor },
    { section: 'history', resultId: crypto.randomUUID() },
    { section: 'ranking' },
    { section: 'self' },
  ]) {
    expect(
      (await request({ Authorization: 'Bearer token' }, JSON.stringify(query))).status,
    ).toBe(200);
    expect(mocks.read).toHaveBeenLastCalledWith(
      {},
      runtime.GAME_OWNER,
      await contentHash({ home: runtime.GAME_OWNER, subject: 'self' }),
      [],
      query,
    );
  }
});
it.each([
  null,
  [],
  { section: 'other' },
  { kind: 'any' },
  { resultId: 'x' },
  { section: 'ranking', cursor: {} },
  { section: 'self', cursor: {} },
  { section: 'self', kind: 'ranked' },
  { section: 'self', resultId: crypto.randomUUID() },
  { resultId: crypto.randomUUID(), kind: 'room' },
  { cursor: { finishedAt: 'invalid', resultId: crypto.randomUUID() } },
])('不正な履歴指定を拒否する: %j', async (query) => {
  expect(
    (await request({ Authorization: 'Bearer token' }, JSON.stringify(query))).status,
  ).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
});
