import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/env';
import app from '../src/worker/index';
import { OrganizationError } from '../src/worker/organization/access';

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  resolve: vi.fn(),
  overview: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
  enter: vi.fn(),
  load: vi.fn(),
  restriction: vi.fn(),
  excluded: vi.fn(),
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
vi.mock('../src/worker/catalog/database', () => ({ loadMatchDefinition: mocks.load }));
vi.mock('../src/worker/results/read', () => ({ readResults: mocks.read }));
vi.mock('../src/worker/organization/moderation', () => ({
  requireUnrestricted: mocks.restriction,
  rankingExclusions: mocks.excluded,
}));
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
  mocks.restriction.mockReset();
  mocks.excluded.mockResolvedValue([]);
  mocks.user.mockResolvedValue({
    data: { user: { id: 'verified', email_confirmed_at: '2026-09-01' } },
    error: null,
  });
  mocks.resolve.mockResolvedValue({
    organization: { id: 'org' },
    account: { actorId: 'old-actor', administrator: false, displayName: '登録名' },
    instance: { id: instanceId, owner: 'urn:uuid:host', state: 'published' },
    permissions: [],
  });
  mocks.enter.mockResolvedValue({
    ok: true,
    room: crypto.randomUUID(),
    token: 'test-token',
    expires: Date.now() + 60000,
  });
  mocks.load.mockResolvedValue({ competition: {}, playersPerMatch: 2, rules: {} });
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
    'local',
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
  expect(mocks.resolve).toHaveBeenCalledWith({}, 'verified', instanceId, false);
  expect(mocks.read).toHaveBeenCalledWith({}, 'urn:uuid:host', 'old-actor', [], {});
});
it.each([
  { administrator: true, permissions: [] },
  { administrator: false, permissions: ['questions'] },
  { administrator: false, permissions: ['authors'] },
  { administrator: false, permissions: ['users'] },
])(
  '準備中の対象運営者は通常の設定・参加・履歴を利用できる: %j',
  async ({ administrator, permissions }) => {
    mocks.resolve.mockResolvedValue({
      organization: { id: 'org' },
      account: { actorId: 'operator', administrator, displayName: '運営者' },
      instance: { id: instanceId, owner: 'private', state: 'preparing' },
      permissions,
    });
    const isolated = {
      ...runtime,
      MATCHMAKER: { getByName: () => ({ enter: mocks.enter }) },
    } as unknown as Env;
    const response = await app.request(
      `https://game.test/api/matchmaking/join?instance=${instanceId}`,
      {
        method: 'POST',
        headers: { Origin: 'https://game.test', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: '運営者' }),
      },
      isolated,
    );
    expect(response.status).toBe(200);
    expect(mocks.enter).toHaveBeenCalledWith(
      'operator',
      '運営者',
      undefined,
      false,
      {
        id: instanceId,
        owner: 'private',
      },
      false,
      undefined,
    );
    expect((await request(`/api/matchmaking/config?instance=${instanceId}`)).status).toBe(
      200,
    );
    expect((await request(`/api/results/overview?instance=${instanceId}`)).status).toBe(
      200,
    );
    expect(mocks.read).toHaveBeenCalledWith({}, 'private', 'operator', [], {});
  },
);
it('対象権限のない一般ユーザーは準備中のAPIを利用できない', async () => {
  mocks.resolve.mockResolvedValue({
    organization: { id: 'org' },
    account: { actorId: 'member', administrator: false },
    instance: { id: instanceId, owner: 'private', state: 'preparing' },
    permissions: [],
  });
  for (const path of [
    '/api/results/overview',
    '/api/matchmaking/join',
    '/api/matchmaking/config',
  ]) {
    expect((await request(`${path}?instance=${instanceId}`)).status).toBe(409);
  }
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
});
it('組織DB障害時に旧owner経路へフォールバックせず、秘密を返さない', async () => {
  mocks.resolve.mockRejectedValue(new Error('private connection string'));
  const response = await request(`/api/results/overview?instance=${instanceId}`);
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('private');
  expect(mocks.read).not.toHaveBeenCalled();
});

it('参加名はリクエストで偽装できず、未登録でも既存試合への復帰はできる', async () => {
  const isolated = {
    ...runtime,
    MATCHMAKER: { getByName: () => ({ enter: mocks.enter }) },
  } as unknown as Env;
  const enter = (operation: string, body: object) =>
    app.request(
      `https://game.test/api/matchmaking/${operation}?instance=${instanceId}`,
      {
        method: 'POST',
        headers: { Origin: 'https://game.test', Authorization: 'Bearer token' },
        body: JSON.stringify(body),
      },
      isolated,
    );
  expect((await enter('join', { name: '偽装名' })).status).toBe(200);
  expect(mocks.enter).toHaveBeenLastCalledWith(
    'old-actor',
    '登録名',
    undefined,
    false,
    {
      id: instanceId,
      owner: 'urn:uuid:host',
    },
    false,
    undefined,
  );
  mocks.restriction.mockRejectedValue(
    new OrganizationError('PARTICIPATION_RESTRICTED', 409),
  );
  const restricted = await enter('join', { name: '登録名' });
  expect(restricted.status).toBe(409);
  expect(await restricted.json()).toEqual({ code: 'PARTICIPATION_RESTRICTED' });
  expect((await enter('resume', {})).status).toBe(200);
  const context = await mocks.resolve();
  mocks.resolve.mockResolvedValue({
    ...context,
    account: { ...context.account, displayName: null },
  });
  mocks.enter.mockClear();
  const rejected = await enter('join', { name: '登録の迂回' });
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({ code: 'PROFILE_REQUIRED' });
  expect(mocks.enter).not.toHaveBeenCalled();
  expect((await enter('resume', {})).status).toBe(200);
  expect(mocks.enter).toHaveBeenCalledWith(
    'old-actor',
    '',
    undefined,
    true,
    {
      id: instanceId,
      owner: 'urn:uuid:host',
    },
    false,
    undefined,
  );
});

it('ランキングのBAN除外はサーバーの組織・インスタンスで取得して集計前に渡す', async () => {
  mocks.excluded.mockResolvedValue(['banned']);
  const response = await request(
    `/api/results/overview?instance=${instanceId}`,
    {},
    JSON.stringify({ excludedActors: [] }),
  );
  expect(response.status).toBe(200);
  expect(mocks.excluded).toHaveBeenCalledWith({}, 'org', instanceId);
  expect(mocks.read).toHaveBeenCalledWith(
    {},
    'urn:uuid:host',
    'old-actor',
    ['banned'],
    {},
  );
});
