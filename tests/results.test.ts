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
import { cancelMatch, matchRecord, startMatch } from '../src/worker/results/lifecycle';
import { ratingChange } from '../src/worker/results/rating';
import { makeResultRecord } from '../src/worker/results/record';
import { resultFixture } from './fixtures/result';

const mocks = vi.hoisted(() => ({ save: vi.fn(), notify: vi.fn() }));
vi.mock('../src/worker/matchmaking/instance', () => ({
  matchmaker: () => ({ matchFinished: mocks.notify }),
}));
vi.mock('../src/worker/results/lifecycle', async (original) => ({
  ...(await original<typeof import('../src/worker/results/lifecycle')>()),
  registerMatch: vi.fn(async (_env, _scope, record) => record),
  startMatch: vi.fn(),
  cancelMatch: vi.fn(),
}));
vi.mock('../src/worker/results/database', async (original) => ({
  ...(await original<typeof import('../src/worker/results/database')>()),
  saveResult: mocks.save,
}));
beforeEach(() => {
  mocks.save.mockReset();
  mocks.notify.mockReset();
  vi.restoreAllMocks();
});
// A finished match room whose result is waiting to be saved.
const finishedRoom = (state: State, owner: string) => ({
  scope: { id: crypto.randomUUID(), owner },
  generations: {},
  state,
  sessions: {},
  resultRetryAt: 1,
  lobby: { expires: 0, sessionExpires: 0, reservations: {}, closed: true },
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

it('終端時の接続・失格・レートを固定し、復帰と切断で変更しない。公開スナップショットに非公開問題を含めない', () => {
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
  expect(ended.completed?.questions).toEqual(state.questions);
  const serialized = JSON.stringify(snapshot(state));
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
it('開発参加の結果は保存せず、開始時刻や定義のない正式試合の結果は記録しない', () => {
  const { state, record } = resultFixture();
  expect(
    makeResultRecord({ ...state, matchKind: 'development' }, record.result),
  ).toBeUndefined();
  delete state.startedAt;
  expect(() => makeResultRecord(state, record.result)).toThrow(
    'RESULT_RECORD_INCOMPLETE',
  );
  state.startedAt = 1000;
  delete state.definition;
  expect(() => makeResultRecord(state, record.result)).toThrow(
    'RESULT_RECORD_INCOMPLETE',
  );
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
    await ctx.storage.put('room', finishedRoom(state, record.owner));
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
    expect(mocks.save.mock.calls[attempt].slice(1)).toEqual([record.owner, record]);
  }
  await runInDurableObject(stub, async (_instance, ctx) => {
    const room = await ctx.storage.get<{ state: typeof state }>('room');
    expect(room).toBeUndefined();
    expect((await ctx.storage.list()).size).toBe(0);
    expect(await ctx.storage.getAlarm()).toBeNull();
  });
  await evictDurableObject(stub);
  await stub.lobbyStatus();
  expect(mocks.save).toHaveBeenCalledTimes(3);
});

it('内容競合は確定にせずDO内の競合原本を破棄する', async () => {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
  const { state, record } = resultFixture();
  mocks.save.mockRejectedValue(new ResultConflict());
  await runInDurableObject(stub, async (_instance, ctx) => {
    await ctx.storage.put('room', finishedRoom(state, record.owner));
    await ctx.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(stub);
  await runInDurableObject(stub, async (_instance, ctx) => {
    const room = await ctx.storage.get<{ state: typeof state }>('room');
    expect(room).toBeUndefined();
    expect((await ctx.storage.list()).size).toBe(0);
    expect(await ctx.storage.getAlarm()).toBeNull();
  });
});

it('DB応答待ちでもDOの同期処理を止めず、再試行期限を延長しない', async () => {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
  const { state, record } = resultFixture();
  let released = false;
  let started = false;
  mocks.save.mockImplementation(async () => {
    started = true;
    while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await runInDurableObject(stub, async (_instance, ctx) => {
    await ctx.storage.put('room', finishedRoom(state, record.owner));
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
  const owner = 'https://second.test';
  record.owner = owner;
  record.definition.competition.owner = owner;
  state.completed = record;
  mocks.save.mockResolvedValue(undefined);
  await runInDurableObject(stub, async (_instance, ctx) => {
    await ctx.storage.put('room', finishedRoom(state, owner));
    await ctx.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(stub);
  expect(mocks.save.mock.calls[0].slice(1)).toEqual([owner, record]);
});

it('開始保存中は同期を処理し、応答消失後も同じ開始原本で再送する', async () => {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
  const { state, record } = resultFixture();
  state.phase = 'WAITING';
  state.result = null;
  delete state.completed;
  const starting = matchRecord(state);
  let released = false;
  const start = vi.mocked(startMatch);
  start.mockClear();
  start.mockImplementationOnce(async () => {
    while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error('COMMITTED_RESPONSE_LOST');
  });
  await runInDurableObject(stub, async (_instance, context) => {
    await context.storage.put('room', {
      ...finishedRoom(state, record.owner),
      starting,
      lifecycleRetryAt: 1,
    });
    await context.storage.setAlarm(Date.now() + 60000);
  });
  const alarm = runDurableObjectAlarm(stub);
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  try {
    await runInDurableObject(stub, async (_instance, context) => {
      const room = await context.storage.get<{ state: State; starting: typeof starting }>(
        'room',
      );
      expect(room?.state.phase).toBe('WAITING');
      expect(room?.starting).toEqual(starting);
    });
  } finally {
    released = true;
    await alarm;
  }
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_instance, context) => {
    const room = await context.storage.get<{ lifecycleRetryAt: number }>('room');
    if (!room) throw new Error('ROOM_NOT_FOUND');
    room.lifecycleRetryAt = 1;
    await context.storage.put('room', room);
    await context.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(stub);
  expect(start.mock.calls.map((call) => call[1])).toEqual([starting, starting]);
  await runInDurableObject(stub, async (_instance, context) => {
    const room = await context.storage.get<{ state: State; starting?: unknown }>('room');
    expect(room?.state.phase).toBe('REVEALING');
    expect(room?.starting).toBeUndefined();
  });
});

it('進行中のアラームは開始・取消処理による重複保存を行わない', async () => {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
  const { state, record } = resultFixture();
  state.phase = 'REVEALING';
  state.result = null;
  delete state.completed;
  state.deadline = Date.now() + 60000;
  await runInDurableObject(stub, async (instance, context) => {
    await context.storage.put('room', {
      ...finishedRoom(state, record.owner),
      lobby: {
        expires: Date.now() + 60000,
        sessionExpires: Date.now() + 60000,
        reservations: {},
        closed: false,
      },
    });
    const transaction = vi.spyOn(context.storage, 'transaction');
    try {
      await instance.alarm();
      expect(transaction).toHaveBeenCalledTimes(1);
      const saved = await context.storage.get<{ state: State }>('room');
      expect(saved?.state.phase).toBe('REVEALING');
      expect(saved?.state.reconnect).not.toBeNull();
    } finally {
      transaction.mockRestore();
    }
  });
});

it('D1確定後の終了通知が失敗しても再起動後に再送し、結果を再保存しない', async () => {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
  const { state, record } = resultFixture();
  mocks.save.mockResolvedValue(undefined);
  mocks.notify.mockRejectedValueOnce(new Error('RPC_DOWN')).mockResolvedValue(undefined);
  await runInDurableObject(stub, async (_, context) => {
    await context.storage.put('room', finishedRoom(state, record.owner));
    await context.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(stub);
  expect(mocks.notify).toHaveBeenCalledWith(record.matchId);
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_, context) => {
    const room = await context.storage.get<{
      state: State;
      notificationRetryAt: number;
    }>('room');
    if (!room) throw new Error('missing room');
    expect(room.state.result?.storage).toBe('confirmed');
    expect(room.notificationRetryAt).toBeGreaterThan(Date.now());
    room.notificationRetryAt = 1;
    await context.storage.put('room', room);
  });
  await runDurableObjectAlarm(stub);
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.notify).toHaveBeenCalledTimes(2);
  await runInDurableObject(stub, async (_, context) => {
    expect((await context.storage.list()).size).toBe(0);
    expect(await context.storage.getAlarm()).toBeNull();
  });
});

it('空の試合への失効要求は失効印だけを保存し、試合やalarmを作らない', async () => {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(
    `match:${crypto.randomUUID()}`,
  );
  expect(
    await stub.cancelReservation('match', 'actor', true, crypto.randomUUID(), 'token'),
  ).toBe(true);
  await runInDurableObject(stub, async (_, context) => {
    expect(await context.storage.list()).toEqual(new Map([['revoked:token', true]]));
    expect(await context.storage.getAlarm()).toBeNull();
  });
});

it('結果保存の失敗は再試行状態と安全な追跡ログを残す', async () => {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
  const { state, record } = resultFixture();
  const failure = new Error('unclassified storage failure');
  failure.stack = 'Error: unclassified storage failure\n    at commit (index.js:123:4)';
  mocks.save.mockRejectedValueOnce(failure);
  await runInDurableObject(stub, async (_instance, ctx) => {
    await ctx.storage.put('room', finishedRoom(state, record.owner));
    await ctx.storage.setAlarm(Date.now() + 60000);
  });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (_instance, ctx) => {
      const room = await ctx.storage.get<{ state: State; resultErrorCode: string }>(
        'room',
      );
      expect(room?.state.result?.storage).toBe('pending');
      expect(room?.resultErrorCode).toBe('INTERNAL');
    });
    const diagnostic = logged.mock.calls
      .map(([value]) => JSON.parse(String(value)))
      .find((entry) => entry.event === 'result_save_failed');
    expect(diagnostic).toMatchObject({
      matchId: record.matchId,
      objectId: stub.id.toString(),
      code: 'INTERNAL',
      errorType: 'Error',
      locations: ['index.js:123:4'],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('unclassified storage failure');
  } finally {
    logged.mockRestore();
  }
});

it.each(['start', 'cancel', 'notify'])(
  '開始・取消・終了通知の失敗を安全なJSONで記録し、再試行を維持する %s',
  async (operation) => {
    const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
    const { state, record } = resultFixture();
    const failure = new Error('private-value');
    failure.stack = 'Error: private-value\n    at retry (index.js:123:4)';
    if (operation === 'notify') {
      mocks.save.mockResolvedValue(undefined);
      mocks.notify.mockRejectedValueOnce(failure);
    } else {
      state.phase = 'WAITING';
      state.result = null;
      delete state.completed;
      vi.mocked(operation === 'start' ? startMatch : cancelMatch).mockRejectedValueOnce(
        failure,
      );
    }
    await runInDurableObject(stub, async (_, context) => {
      await context.storage.put('room', {
        ...finishedRoom(state, record.owner),
        ...(operation === 'start' ? { starting: matchRecord(state) } : {}),
        ...(operation !== 'notify' ? { lifecycleRetryAt: 1 } : {}),
      });
      await context.storage.setAlarm(Date.now() + 60000);
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDurableObjectAlarm(stub);
      const event =
        operation === 'notify'
          ? 'match_finish_notification_failed'
          : 'match_lifecycle_failed';
      const diagnostic = logged.mock.calls
        .map(([value]) => JSON.parse(String(value)))
        .find((entry) => entry.event === event);
      expect(diagnostic).toMatchObject({
        matchId: record.matchId,
        objectId: stub.id.toString(),
        code: 'INTERNAL',
        errorType: 'Error',
        locations: ['index.js:123:4'],
      });
      expect(JSON.stringify(diagnostic)).not.toContain('private-value');
      await runInDurableObject(stub, async (_, context) => {
        const room = await context.storage.get<{
          lifecycleRetryAt?: number;
          notificationRetryAt?: number;
        }>('room');
        expect(
          operation === 'notify' ? room?.notificationRetryAt : room?.lifecycleRetryAt,
        ).toBeGreaterThan(Date.now());
        expect(await context.storage.getAlarm()).not.toBeNull();
      });
    } finally {
      logged.mockRestore();
    }
  },
);
