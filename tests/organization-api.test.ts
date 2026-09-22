import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/env';
import app from '../src/worker/index';

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  resolve: vi.fn(),
  overview: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: mocks.user } }),
}));
vi.mock('../src/worker/organization/database', () => ({
  organizationDatabase: () => ({ db: {}, close: mocks.close }),
  resolveInstance: mocks.resolve,
  overview: mocks.overview,
  setupOrganization: vi.fn(),
  addInstance: vi.fn(),
  publishInstance: vi.fn(),
  setInstanceGrants: vi.fn(),
  renameInstance: vi.fn(),
  accountPermissions: vi.fn(),
}));
vi.mock('../src/worker/results/read', () => ({ readResults: mocks.read }));
vi.mock('../src/worker/db/connection', () => ({
  connectDatabase: () => ({ db: {}, close: async () => {} }),
}));
const runtime: Env = {
  ...(env as unknown as Env),
  ORGANIZATION_ENABLED: 'true',
  INITIAL_ADMIN_SUBJECT: 'test-installer',
  GAME_OWNER: 'https://old.test',
  SUPABASE_URL: 'https://auth.test',
  SUPABASE_PUBLISHABLE_KEY: 'public',
  GAME_DATABASE_URL: 'test',
};
const instanceId = crypto.randomUUID();
const request = (path: string, headers: Record<string, string> = {}, body = '{}') =>
  app.request(
    `https://game.test${path}`,
    {
      method: 'POST',
      headers: { Origin: 'https://game.test', Authorization: 'Bearer token', ...headers },
      body,
    },
    runtime,
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({
    data: { user: { id: 'verified', email_confirmed_at: '2026-09-01' } },
    error: null,
  });
  mocks.resolve.mockResolvedValue({
    organization: { id: 'org' },
    account: { actorId: 'old-actor', administrator: false },
    instance: { id: instanceId, owner: 'urn:uuid:host', state: 'published' },
  });
  mocks.read.mockResolvedValue({ ranking: [], history: [] });
  mocks.overview.mockResolvedValue({ enabled: true, instances: [] });
});

it('組織一覧は検証済みsubjectだけを使い、入力されたsubjectを無視する', async () => {
  const response = await request(
    '/api/organization/overview',
    {},
    JSON.stringify({ subject: 'attacker' }),
  );
  expect(response.status).toBe(200);
  expect(mocks.overview).toHaveBeenCalledWith(
    {},
    'verified',
    'test-installer',
    undefined,
  );
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('組織管理経路もOrigin・本人認証・本文上限を要求する', async () => {
  expect(
    (await request('/api/organization/instances/add', { Origin: 'https://other.test' }))
      .status,
  ).toBe(403);
  expect((await request('/api/organization/setup', { Authorization: '' })).status).toBe(
    401,
  );
  expect((await request('/api/organization/setup', {}, 'x'.repeat(2049))).status).toBe(
    413,
  );
  expect(mocks.overview).not.toHaveBeenCalled();
});
it('本人履歴はサーバーで解決したownerと旧actorのみを参照', async () => {
  const response = await request(
    `/api/results/overview?instance=${instanceId}`,
    {},
    JSON.stringify({ owner: 'other', actorId: 'other' }),
  );
  expect(response.status).toBe(200);
  expect(mocks.resolve).toHaveBeenCalledWith({}, 'verified', instanceId);
  expect(mocks.read).toHaveBeenCalledWith({}, 'urn:uuid:host', 'old-actor');
});
it('準備中への通常対戦・履歴API直接アクセスは運営者でも拒否', async () => {
  mocks.resolve.mockResolvedValue({
    organization: { id: 'org' },
    account: { actorId: 'admin', administrator: true },
    instance: { id: instanceId, owner: 'private', state: 'preparing' },
  });
  for (const path of ['/api/results/overview', '/api/matchmaking/join']) {
    const response = await request(`${path}?instance=${instanceId}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'INSTANCE_PREPARING' });
  }
  expect(mocks.read).not.toHaveBeenCalled();
});
it('組織DB障害時に旧owner経路へフォールバックせず、秘密を返さない', async () => {
  mocks.resolve.mockRejectedValue(new Error('private connection string'));
  const response = await request(`/api/results/overview?instance=${instanceId}`);
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('private');
  expect(mocks.read).not.toHaveBeenCalled();
});
