import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateDefinition } from '../src/worker/catalog/definition';
import { contentHash } from '../src/worker/catalog/hash';
import type { Env } from '../src/worker/env';
import { rules } from '../src/worker/game/rules';
import type { State } from '../src/worker/game/state';
import app from '../src/worker/index';
import { questions } from './fixtures/questions';

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  resolve: vi.fn(),
  load: vi.fn(),
  allowed: vi.fn(),
  blocked: new Set<string>(),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: mocks.user } }),
}));
vi.mock('../src/worker/organization/database', () => ({
  organizationDatabase: () => ({ db: {}, close: async () => {} }),
  resolveInstance: mocks.resolve,
  allowedInstanceActors: mocks.allowed,
}));
vi.mock('../src/worker/catalog/database', () => ({ loadMatchDefinition: mocks.load }));
vi.mock('../src/worker/organization/rooms', () => ({ registerInstanceRoom: vi.fn() }));
vi.mock('../src/worker/organization/moderation', () => ({
  requireUnrestricted: vi.fn(),
}));
const runtime = {
  ...env,
  ORGANIZATION_ENABLED: 'true',
  SUPABASE_URL: 'https://auth.test',
  SUPABASE_PUBLISHABLE_KEY: 'public',
} as unknown as Env;
let id: string;
let owner: string;
let org: string;
let actor = 'a';
const sockets: WebSocket[] = [];
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.blocked.clear();
  id = crypto.randomUUID();
  owner = `urn:uuid:${id}`;
  org = crypto.randomUUID();
  actor = 'a';
  const config = { ...rules, showSelections: true };
  mocks.load.mockResolvedValue(
    await validateDefinition({
      competition: { owner, id: 'demo', version: 1 },
      ruleset: { owner, id: 'demo', version: 1 },
      questionSet: { owner, id: 'demo', version: 1 },
      rules: config,
      questions,
      playersPerMatch: 2,
      rulesHash: await contentHash(config),
      manifestHash: await contentHash(questions),
    }),
  );
  mocks.allowed.mockImplementation(async (_env: Env, _scope: unknown, actors: string[]) =>
    actors.filter((a) => !mocks.blocked.has(a)),
  );
  mocks.user.mockImplementation(async () => ({
    data: { user: { id: actor, email_confirmed_at: 'yes' } },
    error: null,
  }));
  mocks.resolve.mockImplementation(async (_db, subject) => ({
    organization: { id: org },
    account: { actorId: subject, administrator: false, displayName: subject },
    instance: { id, owner, state: 'preparing' },
    permissions: mocks.blocked.has(subject) ? [] : ['questions'],
  }));
});
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});
const post = (path: string, body: object) =>
  app.request(
    `https://game.test/api/matchmaking/${path}?instance=${id}`,
    {
      method: 'POST',
      headers: { Origin: 'https://game.test', Authorization: 'Bearer token' },
      body: JSON.stringify(body),
    },
    runtime,
  );
async function join(name: string) {
  actor = name;
  const response = await post('join', { name });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('Missing session cookie');
  return {
    room: ((await response.json()) as { room: string }).room,
    cookie: cookie.split(';')[0],
  };
}
async function socket(entry: { room: string; cookie: string }) {
  const response = await app.request(
    `https://game.test/api/matchmaking/socket?instance=${id}&room=${entry.room}`,
    {
      headers: {
        Origin: 'https://game.test',
        Upgrade: 'websocket',
        Cookie: entry.cookie,
      },
    },
    runtime,
  );
  if (response.webSocket) {
    response.webSocket.accept();
    sockets.push(response.webSocket);
  }
  return response;
}
async function state(room: string) {
  return runInDurableObject(
    runtime.GAME_ROOM.getByName(`1c:${room}`),
    async (_i, ctx) => {
      const stored = await ctx.storage.get<{ state: State }>('room');
      if (!stored) throw new Error('Missing room');
      return stored.state;
    },
  );
}
it('権限取消の通知で待機を解除し、古いcookie・再参加を拒否する', async () => {
  const a = await join('a');
  expect((await socket(a)).status).toBe(101);
  mocks.blocked.add('a');
  await runtime.MATCHMAKER.getByName(org).refreshWaiting('a', id);
  expect((await state(a.room)).players).toEqual([]);
  expect((await socket(a)).status).toBe(401);
  expect((await post('join', { name: 'a' })).status).toBe(409);
  expect((await post('resume', {})).status).toBe(409);
});
it('通知が失敗しても開始直前に全員の権限を確認し、取消対象を除外する', async () => {
  const a = await join('a');
  const b = await join('b');
  expect(b.room).toBe(a.room);
  expect((await socket(a)).status).toBe(101);
  mocks.blocked.add('a');
  expect((await socket(b)).status).toBe(101);
  expect((await state(a.room)).phase).toBe('WAITING');
  expect((await state(a.room)).players.map((p) => p.id)).toEqual(['b']);
});
it('準備中の権限を失っても自分の待機を取り消せる', async () => {
  const a = await join('a');
  mocks.blocked.add('a');
  expect((await post('cancel', { room: a.room })).status).toBe(200);
  expect((await state(a.room)).players).toEqual([]);
  expect(mocks.resolve).toHaveBeenLastCalledWith({}, 'a', id, true);
});
it('開始済み試合は権限取消後も維持し、resumeと再接続を許可する', async () => {
  const a = await join('a');
  const b = await join('b');
  await socket(a);
  await socket(b);
  expect((await state(a.room)).phase).not.toBe('WAITING');
  mocks.blocked.add('a');
  actor = 'a';
  await runtime.MATCHMAKER.getByName(org).refreshWaiting('a', id);
  expect((await state(a.room)).players.map((p) => p.id)).toContain('a');
  expect((await post('resume', {})).status).toBe(200);
  expect((await socket(a)).status).toBe(101);
});
it('通知が届かなくても待機列の定期確認で取消対象を解除する', async () => {
  const a = await join('a');
  await socket(a);
  mocks.blocked.add('a');
  await runDurableObjectAlarm(runtime.MATCHMAKER.getByName(org));
  expect((await state(a.room)).players).toEqual([]);
});
it('受付後に権限が変わった遅延reserveを拒否する', async () => {
  mocks.blocked.add('a');
  const definition = await mocks.load();
  const result = await runtime.GAME_ROOM.getByName(`1c:${crypto.randomUUID()}`).reserve(
    'a',
    'A',
    'late',
    definition,
    { id, owner },
    'generation',
  );
  expect(result).toEqual({ ok: false, code: 'INSTANCE_NOT_FOUND' });
});

it('インスタンス全体の再確認で一般待機だけを解除し、許可された運営者は残す', async () => {
  const a = await join('a');
  const b = await join('b');
  mocks.blocked.add('a');
  await runtime.MATCHMAKER.getByName(org).refreshInstanceWaiting(id);
  expect((await state(a.room)).players.map((p) => p.id)).toEqual(['b']);
  actor = 'b';
  expect((await post('resume', {})).status).toBe(200);
  expect(b.room).toBe(a.room);
});

it('アーカイブの全体再確認でも開始済み試合・再接続を維持する', async () => {
  const a = await join('a');
  const b = await join('b');
  await socket(a);
  await socket(b);
  mocks.blocked.add('a');
  mocks.blocked.add('b');
  await runtime.MATCHMAKER.getByName(org).refreshInstanceWaiting(id);
  expect((await state(a.room)).players).toHaveLength(2);
  actor = 'a';
  expect((await post('resume', {})).status).toBe(200);
  expect((await socket(a)).status).toBe(101);
});

it('退会の受付停止は待機・試合中を拒否し、同じ操作IDだけが解除できる', async () => {
  const maker = runtime.MATCHMAKER.getByName(org);
  const operationId = crypto.randomUUID();
  const a = await join('a');
  expect(await maker.beginWithdrawal('a', operationId)).toEqual({
    ok: false,
    code: 'CANCEL_WAITING_FIRST',
  });
  await maker.cancelWithdrawal('a', operationId);
  const b = await join('b');
  await socket(a);
  await socket(b);
  expect(await maker.beginWithdrawal('a', operationId)).toEqual({
    ok: false,
    code: 'MATCH_STARTED',
  });
  await maker.cancelWithdrawal('a', operationId);
  expect(await maker.beginWithdrawal('unused', operationId)).toEqual({ ok: true });
  await maker.cancelWithdrawal('unused', crypto.randomUUID());
  expect(
    await maker.enter('unused', 'unused', undefined, false, { id, owner }),
  ).toMatchObject({ ok: false, code: 'WITHDRAWAL_PENDING' });
  await maker.cancelWithdrawal('unused', operationId);
  expect(
    await maker.enter('unused', 'unused', undefined, false, { id, owner }),
  ).toMatchObject({ ok: true });
});

it('完全削除は進行中・未保存結果を拒否し、保存済み部屋だけを消去する', async () => {
  const a = await join('a'),
    b = await join('b');
  const room = runtime.GAME_ROOM.getByName(`1c:${a.room}`);
  await socket(a);
  await socket(b);
  await runInDurableObject(room, async (_instance, ctx) => {
    const saved = await ctx.storage.get<{ state: State }>('room');
    if (!saved) throw new Error('MISSING_ROOM');
    saved.state.phase = 'REVEALING';
    await ctx.storage.put('room', saved);
  });
  expect((await room.deletionStatus(id)).safe).toBe(false);
  expect(await room.eraseInstance(id)).toEqual({ ok: false, code: 'MATCH_STARTED' });
  await runInDurableObject(room, async (_instance, ctx) => {
    const saved = await ctx.storage.get<{ state: State }>('room');
    if (!saved) throw new Error('MISSING_ROOM');
    saved.state.phase = 'FINISHED';
    saved.state.result = {
      id: crypto.randomUUID(),
      winnerId: 'a',
      reason: 'exhausted',
      finishedAt: Date.now(),
      storage: 'pending',
    };
    saved.state.completed = { result: saved.state.result } as State['completed'];
    await ctx.storage.put('room', saved);
  });
  expect((await room.deletionStatus(id)).safe).toBe(false);
  expect(await room.eraseInstance(id)).toEqual({ ok: false, code: 'RESULT_PENDING' });
  await runInDurableObject(room, async (_instance, ctx) => {
    const saved = await ctx.storage.get<{ state: State }>('room');
    if (!saved?.state.result) throw new Error('MISSING_RESULT');
    saved.state.result.storage = 'confirmed';
    await ctx.storage.put('room', saved);
  });
  expect(await room.eraseInstance(crypto.randomUUID())).toEqual({
    ok: false,
    code: 'INSTANCE_MISMATCH',
  });
  expect((await room.deletionStatus(id)).safe).toBe(true);
  await room.eraseInstance(id);
  await room.eraseInstance(id);
  expect(await room.inventoryScope()).toBeNull();
  expect(
    await room.reserve('a', '再入室', 'token', undefined, { id, owner }),
  ).toMatchObject({ ok: false });
});
