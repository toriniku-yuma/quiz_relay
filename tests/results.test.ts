import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/env';
import {
  advance,
  forfeitPlayer,
  type State,
  snapshot,
  updateConnections,
} from '../src/worker/game/state';
import { ResultConflict } from '../src/worker/results/database';
import { ratingChange } from '../src/worker/results/rating';
import { makeResultRecord } from '../src/worker/results/record';
import { resultFixture } from './fixtures/result';

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../src/worker/organization/rooms', () => ({ registerInstanceRoom: vi.fn() }));
vi.mock('../src/worker/results/database', async (original) => ({
  ...(await original<typeof import('../src/worker/results/database')>()),
  saveResult: mocks.save,
}));
beforeEach(() => {
  mocks.save.mockReset();
  vi.restoreAllMocks();
});

it('承認済みレート：勝敗・引き分け・失格・未復帰・INVALIDと非ランク戦', () => {
  const { record } = resultFixture();
  const [firstPlayer, secondPlayer] = record.players;
  expect(ratingChange('ranked', record.result, firstPlayer)).toBe(20);
  expect(ratingChange('ranked', record.result, secondPlayer)).toBe(-20);
  const draw = { ...record.result, reason: 'exhausted' as const, winnerId: null };
  expect(ratingChange('ranked', draw, secondPlayer)).toBe(0);
  expect(ratingChange('ranked', draw, { ...secondPlayer, disqualified: true })).toBe(-20);
  expect(ratingChange('ranked', draw, { ...secondPlayer, connected: false })).toBe(-20);
  for (const reason of ['connections', 'disqualifications'] as const) {
    const invalid = { ...draw, reason };
    expect(ratingChange('ranked', invalid, secondPlayer)).toBe(20);
    expect(ratingChange('ranked', invalid, { ...secondPlayer, connected: false })).toBe(
      -20,
    );
    expect(ratingChange('ranked', invalid, { ...secondPlayer, disqualified: true })).toBe(
      -20,
    );
  }
  for (const kind of ['casual', 'room', 'development'] as const)
    expect(
      ratingChange(kind, record.result, {
        ...firstPlayer,
        connected: false,
        disqualified: true,
      }),
    ).toBe(0);
});

it('終端時の接続・失格・レートを固定し、復帰と切断で変更しない。非公開問題を含めない', () => {
  const { state } = resultFixture();
  state.phase = 'REVEALING';
  state.result = null;
  delete state.completed;
  state.reconnect = { deadline: 5000, remaining: 100 };
  updateConnections(state, new Set(['a']), 5000);
  const ended = structuredClone(state) as State;
  expect(ended.completed?.players.map((player) => player.ratingDelta)).toEqual([20, -20]);
  const saved = structuredClone(state.completed);
  updateConnections(state, new Set(['a', 'b']), 5001);
  advance(state, 5002);
  expect(state.completed).toEqual(saved);
  expect(ended.result?.ratingChanges).toEqual([
    { actorId: 'a', delta: 20 },
    { actorId: 'b', delta: -20 },
  ]);
  const serialized = JSON.stringify(state.completed);
  expect(serialized).not.toContain(state.questions[0].text);
  expect(serialized).not.toContain('"answer"');
  expect(snapshot(state)).not.toHaveProperty('completed');
});

it('全員切断で全員減少。一時切断から期限前に復帰したら切断減点しない', () => {
  const { state } = resultFixture();
  state.phase = 'REVEALING';
  state.result = null;
  delete state.completed;
  updateConnections(state, new Set(), 3000);
  const deadline = state.reconnect?.deadline;
  if (!deadline) throw new Error('NO_RECONNECT');
  const disconnected = structuredClone(state);
  updateConnections(disconnected, new Set(), deadline);
  expect(disconnected.completed?.players.map((player) => player.ratingDelta)).toEqual([
    -20, -20,
  ]);
  updateConnections(state, new Set(['a', 'b']), deadline - 1);
  expect(state.reconnect).toBeNull();
  expect(
    makeResultRecord(state, {
      id: crypto.randomUUID(),
      winnerId: 'a',
      reason: 'target_reached',
      finishedAt: deadline,
    })?.players[0].ratingDelta,
  ).toBe(20);
});

it.each(['ranked', 'casual', 'room'] as const)(
  '強制離脱は本人だけに適用し、%sの終端原本とレートを再試行・再接続で変更しない',
  (kind) => {
    const { state } = resultFixture();
    state.phase = 'REVEALING';
    state.result = null;
    delete state.completed;
    state.matchKind = kind;
    const template = state.players[1];
    state.players.push({ ...template, id: 'c' }, { ...template, id: 'd' });
    forfeitPlayer(state, 'b', 3000);
    expect(state.phase).toBe('REVEALING');
    expect(state.players.find((player) => player.id === 'b')).toMatchObject({
      forfeited: true,
      disqualified: true,
      connected: false,
      mistakes: 0,
    });
    updateConnections(state, new Set(['a', 'b', 'c', 'd']), 3001);
    expect(state.players.find((player) => player.id === 'b')?.connected).toBe(false);
    forfeitPlayer(state, 'c', 3002);
    forfeitPlayer(state, 'd', 3003);
    expect((state as State).result?.reason).toBe(
      kind === 'room' ? 'last_remaining' : 'disqualifications',
    );
    expect(
      (state as State).completed?.players.find((player) => player.id === 'b')
        ?.ratingDelta,
    ).toBe(kind === 'ranked' ? -20 : 0);
    const original = structuredClone(state.completed);
    forfeitPlayer(state, 'b', 4000);
    forfeitPlayer(state, 'a', 4001);
    updateConnections(state, new Set(['a', 'b', 'c', 'd']), 4002);
    advance(state, 4003);
    expect(state.completed).toEqual(original);
  },
);
it('待機中の強制離脱では結果・レートを生成しない', () => {
  const { state } = resultFixture();
  state.phase = 'WAITING';
  state.result = null;
  delete state.completed;
  forfeitPlayer(state, 'a', 3000);
  expect(state.completed).toBeUndefined();
  expect(state.players[0].forfeited).toBeUndefined();
});
it('旧DO・開発参加の結果は遡及保存しない', () => {
  const { state, record } = resultFixture();
  delete state.startedAt;
  expect(makeResultRecord(state, record.result)).toBeUndefined();
  state.startedAt = 1000;
  delete state.definition;
  expect(makeResultRecord(state, record.result)).toBeUndefined();
});

it('D01/D02: DB停止・DO復帰・commit後応答消失でも同一原本で再試行し確定する', async () => {
  const runtime = env as unknown as Env;
  const stub = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  const { state, record } = resultFixture();
  mocks.save
    .mockRejectedValueOnce(new Error('DB_DOWN'))
    .mockRejectedValueOnce(new Error('COMMITTED_RESPONSE_LOST'))
    .mockResolvedValue(undefined);
  await runInDurableObject(stub, async (_instance, ctx) => {
    await ctx.storage.put('room', { state, sessions: {}, resultRetryAt: 1 });
    await ctx.storage.setAlarm(Date.now() + 60000);
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      await evictDurableObject(stub);
      await runInDurableObject(stub, async (_instance, ctx) => {
        const room = await ctx.storage.get<{
          state: typeof state;
          resultRetryAt: number;
        }>('room');
        if (!room) throw new Error('NO_ROOM');
        expect(room.state.result?.storage).toBe('pending');
        room.resultRetryAt = 1;
        await ctx.storage.put('room', room);
        await ctx.storage.setAlarm(Date.now() + 60000);
      });
    }
    await runDurableObjectAlarm(stub);
    expect(mocks.save.mock.calls.length, `attempt ${attempt}`).toBe(attempt + 1);
    expect(mocks.save.mock.calls[attempt][1]).toEqual(record);
  }
  await runInDurableObject(stub, async (_instance, ctx) => {
    const room = await ctx.storage.get<{ state: typeof state }>('room');
    expect(room?.state.result?.storage).toBe('confirmed');
    expect(await ctx.storage.getAlarm()).toBeNull();
  });
  await evictDurableObject(stub);
  await stub.lobbyStatus();
  expect(mocks.save).toHaveBeenCalledTimes(3);
});

it('内容競合は確定にせず原本を保持する', async () => {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
  const { state, record } = resultFixture();
  mocks.save.mockRejectedValue(new ResultConflict());
  await runInDurableObject(stub, async (_instance, ctx) => {
    await ctx.storage.put('room', { state, sessions: {}, resultRetryAt: 1 });
    await ctx.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(stub);
  await runInDurableObject(stub, async (_instance, ctx) => {
    const room = await ctx.storage.get<{ state: typeof state }>('room');
    expect(room?.state.result?.storage).toBe('conflict');
    expect(room?.state.completed).toEqual(record);
  });
});

it('DB応答待ちでもDOの同期処理を止めず、再試行期限を延長しない', async () => {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
  const { state } = resultFixture();
  let released = false;
  let started = false;
  mocks.save.mockImplementation(async () => {
    started = true;
    while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await runInDurableObject(stub, async (_instance, ctx) => {
    await ctx.storage.put('room', { state, sessions: {}, resultRetryAt: 1 });
    await ctx.storage.setAlarm(Date.now() + 60000);
  });
  const alarm = runDurableObjectAlarm(stub);
  await vi.waitFor(() => expect(started).toBe(true));
  try {
    await runInDurableObject(stub, async (_instance, ctx) => {
      const room = await ctx.storage.get<{ state: typeof state; resultRetryAt: number }>(
        'room',
      );
      expect(room?.state.result?.storage).toBe('pending');
      expect(room?.resultRetryAt).toBeGreaterThan(Date.now());
    });
  } finally {
    released = true;
    await alarm;
  }
});

it('追加インスタンスの結果は部屋に保存したownerで保存し、原本を変更しない', async () => {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
  const { state, record } = resultFixture();
  const scope = { id: crypto.randomUUID(), owner: 'https://second.test' };
  record.owner = scope.owner;
  record.definition.competition.owner = scope.owner;
  state.completed = record;
  mocks.save.mockResolvedValue(undefined);
  await runInDurableObject(stub, async (_instance, ctx) => {
    await ctx.storage.put('room', { state, scope, sessions: {}, resultRetryAt: 1 });
    await ctx.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(stub);
  expect(mocks.save.mock.calls[0][0].GAME_OWNER).toBe(scope.owner);
  expect(mocks.save.mock.calls[0][1]).toEqual(record);
});
