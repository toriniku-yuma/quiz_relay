import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/env';
import app from '../src/worker/index';

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  mutate: vi.fn(),
  overview: vi.fn(),
  verified: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../src/worker/auth/clerk', () => ({ authenticateClerk: mocks.identity }));
vi.mock('../src/worker/organization/database', async (original) => ({
  ...(await original<typeof import('../src/worker/organization/database')>()),
  organizationDatabase: () => ({ db: {}, close: mocks.close }),
}));
vi.mock('../src/worker/questions/database', async (original) => ({
  ...(await original<typeof import('../src/worker/questions/database')>()),
  questionMutation: mocks.mutate,
  questionOverview: mocks.overview,
}));
vi.mock('../src/worker/questions/reports', () => ({
  verifiedReportedQuestion: mocks.verified,
}));
const runtime = { ...env, GAME_CONFIG_PROFILE: 'local' } as unknown as Env;
const instance = crypto.randomUUID();
const request = (body: object | string, headers: Record<string, string> = {}) =>
  app.request(
    `https://game.test/api/questions/manage?instance=${instance}`,
    {
      method: 'POST',
      headers: { Origin: 'https://game.test', Authorization: 'Bearer test', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    runtime,
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockResolvedValue({
    subject: 'verified-subject',
    displayName: '作問者',
  });
  mocks.mutate.mockResolvedValue({ ok: true });
  mocks.overview.mockResolvedValue({ review: false, difficulty: [], submissions: [] });
  mocks.verified.mockResolvedValue({ id: 'observed' });
});
it('Origin・本人認証・JSONサイズを操作前に確認する', async () => {
  expect((await request({}, { Origin: 'https://other.test' })).status).toBe(403);
  expect((await request({}, { Authorization: '' })).status).toBe(401);
  expect((await request('x'.repeat(5000001))).status).toBe(413);
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it('画面別取得条件を検証済み本人情報とともに渡す', async () => {
  const view = { page: 'edit', id: crypto.randomUUID() };
  expect((await request({ operation: 'overview', view })).status).toBe(200);
  expect(mocks.overview).toHaveBeenCalledWith(
    {},
    'verified-subject',
    instance,
    undefined,
    view,
  );
  expect(mocks.close).toHaveBeenCalled();
});
it('入力された他人のsubjectや権限を認証情報として使わない', async () => {
  const body = {
    operation: 'approve',
    subject: 'attacker',
    administrator: true,
    id: 'question',
  };
  expect((await request(body)).status).toBe(200);
  expect(mocks.mutate).toHaveBeenCalledWith(
    {},
    'verified-subject',
    instance,
    body,
    'local',
    undefined,
    '作問者',
  );
});
it('通報では本人の出題済み記録の検証結果だけを渡す', async () => {
  const body = {
    operation: 'report',
    matchId: 'result',
    questionId: 'observed',
    observedQuestion: { id: 'fake' },
  };
  expect((await request(body)).status).toBe(200);
  expect(mocks.verified).toHaveBeenCalledWith(
    runtime,
    'verified-subject',
    instance,
    'result',
    'observed',
  );
  expect(mocks.mutate).toHaveBeenCalledWith(
    {},
    'verified-subject',
    instance,
    body,
    'local',
    { id: 'observed' },
    '作問者',
  );
});
