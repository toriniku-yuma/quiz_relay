import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { MatchDefinition } from '../src/worker/catalog/definition';
import { validateDefinition } from '../src/worker/catalog/definition';
import { contentHash } from '../src/worker/catalog/hash';
import type { Env } from '../src/worker/env';
import { dummyCharacters } from '../src/worker/game/questions';
import { rules } from '../src/worker/game/rules';
import type { State } from '../src/worker/game/state';
import app from '../src/worker/index';
import { questionProvenance, questions } from './fixtures/questions';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  identity: vi.fn(),
  instance: { organizationId: '', id: '', owner: 'https://game.test' },
}));
vi.mock('../src/worker/organization/rooms', () => ({ registerInstanceRoom: vi.fn() }));
vi.mock('../src/worker/organization/moderation', () => ({
  requireUnrestricted: vi.fn(),
}));
vi.mock('../src/worker/catalog/database', () => ({
  loadMatchDefinition: mocks.load,
  loadFixedVersion: mocks.load,
}));
vi.mock('../src/worker/auth/clerk', () => ({ authenticateClerk: mocks.identity }));
vi.mock('../src/worker/organization/database', () => ({
  allowedInstanceActors: async (_env: unknown, _scope: unknown, actors: string[]) =>
    actors,
  organizationDatabase: () => ({ db: {}, close: async () => {} }),
  resolveInstance: async () => ({
    organization: { id: mocks.instance.organizationId },
    account: { actorId: 'user-1-actor', administrator: false, displayName: '参加者' },
    instance: {
      id: mocks.instance.id,
      owner: mocks.instance.owner,
      state: 'published',
      rankedPauseReason: null,
    },
    permissions: [],
  }),
}));
const runtime = env as unknown as Env;
function matchIdOf(stub: ReturnType<Env['GAME_ROOM']['getByName']>) {
  const name = stub.id.name;
  if (!name?.startsWith('match:')) throw new Error('MATCH_FIXTURE_REQUIRED');
  return name.slice(6);
}

const owner = 'https://game.test';
it('試合DOの名前と異なる試合IDで予約すると、状態を作らず拒否する', async () => {
  const stub = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance, context) => {
    await expect(
      instance.reserve(
        crypto.randomUUID(),
        'a',
        'A',
        'token',
        undefined,
        { id: crypto.randomUUID(), owner },
        'generation',
      ),
    ).rejects.toThrow('MATCH_ID_MISMATCH');
    expect((await context.storage.list()).size).toBe(0);
  });
});
const rankedScope = { id: crypto.randomUUID(), owner };
const generationOf = (actor: string) => `generation-${actor}`;
const emptyQueue = () => ({
  actors: {},
  foreign: {},
  foreignIntent: {},
  foreignDepartures: {},
  foreignChecked: {},
  withdrawals: {},
  loggingOut: {},
  switches: {},
  rates: {},
});
let definition: MatchDefinition;
beforeEach(async () => {
  mocks.load.mockReset();
  mocks.identity.mockReset();
  mocks.instance.organizationId = crypto.randomUUID();
  mocks.instance.id = rankedScope.id;
  const config = { ...rules, showSelections: true };
  const manifest = questions.map((question) => ({
    ...question,
    version: 1,
    distractors: [...dummyCharacters],
    ...questionProvenance,
  }));
  definition = await validateDefinition({
    competition: { owner, id: 'demo', version: 1 },
    ruleset: { owner, id: 'standard', version: 1 },
    questionSet: { owner, id: 'mock', version: 1 },
    rules: config,
    rulesHash: await contentHash(config),
    questions: manifest,
    manifestHash: await contentHash(manifest),
    playersPerMatch: 4,
  });
  mocks.load.mockImplementation(async () => structuredClone(definition));
  mocks.identity.mockResolvedValue({ subject: 'user-1', displayName: '作問者' });
});

async function state(
  stub: DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>,
) {
  return runInDurableObject(
    stub,
    async (_instance, ctx) => (await ctx.storage.get<{ state: State }>('room'))?.state,
  );
}
async function socket(
  stub: DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>,
  token: string,
  instanceId = rankedScope.id,
) {
  const response = await stub.fetch('https://game.test', {
    headers: {
      Upgrade: 'websocket',
      'X-Game-Session': token,
      'X-Game-Instance': instanceId,
    },
  });
  if (!response.webSocket) throw new Error(`Upgrade failed ${response.status}`);
  response.webSocket.accept();
  return response.webSocket;
}

it('カジュアルは実力帯なしで自動開始し、存在しない部屋への切替では元の試合を保持する', async () => {
  definition.kind = 'casual';
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner, mode: 'casual' as const };
  const sockets: WebSocket[] = [];
  const admissions = [];
  try {
    for (let i = 0; i < 4; i++) {
      const entered = await queue.enter(
        `casual-${i}`,
        `参加者${i}`,
        false,
        scope,
        i >= 2,
      );
      if (!entered.ok) throw new Error(entered.code);
      admissions.push(entered);
      sockets.push(
        await socket(
          runtime.GAME_ROOM.getByName(`match:${entered.room}`),
          entered.token,
          scope.id,
        ),
      );
    }
    expect(new Set(admissions.map((admission) => admission.room)).size).toBe(1);
    const saved = await state(runtime.GAME_ROOM.getByName(`match:${admissions[0].room}`));
    expect(saved?.phase).toBe('REVEALING');
    expect(saved?.matchKind).toBe('casual');
    expect(saved?.players.filter((player) => player.guest)).toHaveLength(2);
    expect(
      mocks.load.mock.calls
        .filter(([, reference]) => !reference)
        .every(([settings]) => settings.GAME_CONFIG_PROFILE.endsWith('-casual')),
    ).toBe(true);
    expect(
      await queue.enter('casual-0', '参加者0', false, {
        ...scope,
        mode: undefined,
      }),
    ).toMatchObject({ ok: false, code: 'OTHER_INSTANCE_ACTIVE' });
    const roomId = crypto.randomUUID();
    expect(
      await queue.enterRoom(
        { id: 'casual-0', name: '参加者0', guest: false },
        roomId,
        { ...scope, mode: 'room' },
        { operationId: crypto.randomUUID(), password: '', invite: '' },
      ),
    ).toMatchObject({ ok: false, code: 'ROOM_CLOSED' });
    expect(
      await runInDurableObject(
        runtime.GAME_ROOM.getByName(`room:${roomId}`),
        async (_instance, ctx) => ctx.storage.get('user-room'),
      ),
    ).toBeUndefined();
    expect(
      await queue.cancel('casual-0', admissions[0].room, false, scope.id),
    ).toMatchObject({ ok: false });
  } finally {
    for (const socket of sockets) socket.close();
  }
}, 20000);
it('2人のカジュアルマッチは登録ユーザーとゲストの接続で同じ試合を自動開始する', async () => {
  definition.kind = 'casual';
  definition.playersPerMatch = 2;
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner, mode: 'casual' as const };
  const first = await queue.enter(
    'registered',
    '登録ユーザー',
    false,
    scope,
    false,
    crypto.randomUUID(),
  );
  const second = await queue.enter(
    'guest',
    'ゲスト',
    false,
    scope,
    true,
    crypto.randomUUID(),
  );
  if (!first.ok || !second.ok) throw new Error('setup');
  expect(second.room).toBe(first.room);
  const room = runtime.GAME_ROOM.getByName(`match:${first.room}`);
  const firstSocket = await socket(room, first.token, scope.id),
    secondSocket = await socket(room, second.token, scope.id);
  try {
    expect(await state(room)).toMatchObject({
      phase: 'REVEALING',
      matchKind: 'casual',
      playersRequired: 2,
    });
    expect((await state(room))?.players.filter((player) => player.guest)).toHaveLength(1);
  } finally {
    firstSocket.close();
    secondSocket.close();
  }
});
it('新規参加だけが旧本人を強制離脱させ、同じ操作の再試行・古い操作・復帰要求は重複処理しない', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner };
  const operationId = crypto.randomUUID();
  const first = await queue.enter('switch-a', 'A', false, scope, false, operationId);
  if (!first.ok) throw new Error(first.code);
  const room = runtime.GAME_ROOM.getByName(`match:${first.room}`);
  const sockets = [await socket(room, first.token, scope.id)];
  try {
    for (let i = 1; i < 4; i++) {
      const entry = await queue.enter(
        `switch-${i}`,
        `P${i}`,
        false,
        scope,
        false,
        crypto.randomUUID(),
      );
      if (!entry.ok) throw new Error(entry.code);
      sockets.push(await socket(room, entry.token, scope.id));
    }
    const other = { ...scope, mode: 'casual' as const };
    expect(await queue.enter('switch-a', '', true, other)).toMatchObject({
      ok: false,
      code: 'OTHER_INSTANCE_ACTIVE',
    });
    expect((await state(room))?.players[0].forfeited).toBeUndefined();
    const replacementId = crypto.randomUUID();
    const second = await queue.enter('switch-a', 'A', false, other, false, replacementId);
    if (!second.ok) throw new Error(second.code);
    expect(second.room).not.toBe(first.room);
    expect((await state(room))?.phase).toBe('REVEALING');
    expect((await state(room))?.players[0]).toMatchObject({
      forfeited: true,
      connected: false,
      disqualified: true,
    });
    expect(
      await queue.enter('switch-a', 'A', false, other, false, replacementId),
    ).toEqual(second);
    expect(
      await queue.enter('switch-a', 'changed', false, other, false, replacementId),
    ).toMatchObject({ ok: false, code: 'OPERATION_CONFLICT' });
    expect(
      await queue.enter('switch-a', 'A', false, scope, false, operationId),
    ).toMatchObject({ ok: false, code: 'STALE_REQUEST' });
    expect(await queue.cancel('switch-a', first.room, false, scope.id)).toMatchObject({
      ok: false,
      code: 'STALE_ROOM',
    });
    expect(
      await room.cancelReservation('switch-a', true, undefined, first.token, true),
    ).toBe(true);
    expect(
      (await state(room))?.players.filter((player) => player.forfeited),
    ).toHaveLength(1);
    expect(await socket(room, first.token, scope.id).catch(() => null)).toBeNull();
  } finally {
    for (const ws of sockets) ws.close();
  }
}, 20000);

it('旧離脱が未確認なら2枠を保持し3つ目を拒否し、Alarmで再試行して回収する', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = await queue.enter(
    'a',
    'A',
    false,
    rankedScope,
    false,
    crypto.randomUUID(),
  );
  if (!first.ok) throw new Error(first.code);
  let unavailable = true;
  let restore = () => {};
  await runInDurableObject(queue, async (instance) => {
    const target = instance as unknown as {
      room(id: string): ReturnType<Env['GAME_ROOM']['getByName']>;
    };
    const original = target.room.bind(target);
    const spy = vi.spyOn(target, 'room').mockImplementation((id) => {
      const actual = original(id);
      return id !== first.room
        ? actual
        : ({
            lobbyStatus: () => actual.lobbyStatus(),
            reserve: (...args: Parameters<typeof actual.reserve>) =>
              actual.reserve(...args),
            cancelReservation: (...args: Parameters<typeof actual.cancelReservation>) => {
              if (args[4] && unavailable) throw new Error('RPC lost');
              return actual.cancelReservation(...args);
            },
          } as unknown as typeof actual);
    });
    restore = () => spy.mockRestore();
  });
  try {
    const second = await queue.enter(
      'a',
      'A',
      false,
      rankedScope,
      false,
      crypto.randomUUID(),
    );
    expect(second.ok).toBe(true);
    expect(
      await queue.enter('a', 'A', false, rankedScope, false, crypto.randomUUID()),
    ).toMatchObject({ ok: false, code: 'MATCH_SWITCH_PENDING' });
    unavailable = false;
    await runDurableObjectAlarm(queue);
    expect(
      await runInDurableObject(
        queue,
        async (_i, ctx) =>
          (await ctx.storage.get<{ switches?: object }>('queue'))?.switches,
      ),
    ).toEqual({});
    expect(
      (await queue.enter('a', 'A', false, rankedScope, false, crypto.randomUUID())).ok,
    ).toBe(true);
  } finally {
    restore();
  }
});

it('切替結果不明→ログアウト→新待機取消の後も、元の進行中試合へ新トークンで復帰する', async () => {
  definition.playersPerMatch = 2;
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = await queue.enter(
    'a',
    'A',
    false,
    rankedScope,
    false,
    crypto.randomUUID(),
  );
  const partner = await queue.enter('b', 'B', false, rankedScope);
  if (!first.ok || !partner.ok) throw new Error('setup');
  const oldRoom = runtime.GAME_ROOM.getByName(`match:${first.room}`);
  const sockets = [
    await socket(oldRoom, first.token),
    await socket(oldRoom, partner.token),
  ];
  let restore = () => {};
  let lostRoom = '';
  await runInDurableObject(queue, async (instance) => {
    const target = instance as unknown as { room(id: string): typeof oldRoom };
    const original = target.room.bind(target);
    const spy = vi.spyOn(target, 'room').mockImplementation((id) => {
      const actual = original(id);
      return id === first.room
        ? actual
        : ({
            lobbyStatus: () => actual.lobbyStatus(),
            cancelReservation: (...args: Parameters<typeof actual.cancelReservation>) =>
              actual.cancelReservation(...args),
            reserve: async (...args: Parameters<typeof actual.reserve>) => {
              await actual.reserve(...args);
              lostRoom = id;
              throw new Error('reply lost');
            },
          } as unknown as typeof actual);
    });
    restore = () => spy.mockRestore();
  });
  try {
    expect(
      await queue.enter('a', 'A', false, rankedScope, false, crypto.randomUUID()),
    ).toMatchObject({ ok: false, code: 'GAME_DATABASE_UNAVAILABLE' });
    restore();
    await queue.logoutActor('a');
    expect((await state(oldRoom))?.phase).toBe('REVEALING');
    expect(await queue.cancel('a', lostRoom, false, rankedScope.id)).toMatchObject({
      ok: true,
    });
    const resumed = await queue.enter('a', '', true, rankedScope);
    if (!resumed.ok) throw new Error(resumed.code);
    expect(resumed.room).toBe(first.room);
    expect(resumed.token).not.toBe(first.token);
    sockets.push(await socket(oldRoom, resumed.token));
    expect((await state(oldRoom))?.players[0].forfeited).toBeUndefined();
  } finally {
    restore();
    for (const ws of sockets) ws.close();
  }
});

it.each([2, 3, 4])(
  'M01/M03: %i distinct connected actors start once; duplicate tabs and reservations do not start',
  async (count) => {
    definition.playersPerMatch = count;
    const stub = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
    const sockets: WebSocket[] = [];
    try {
      for (let i = 0; i < count; i++)
        expect(
          (
            await stub.reserve(
              matchIdOf(stub),
              `actor-${i}`,
              `P${i}`,
              `token-${i}`,
              definition,
              rankedScope,
              generationOf(`actor-${i}`),
            )
          ).ok,
        ).toBe(true);
      expect(
        (
          await stub.reserve(
            matchIdOf(stub),
            'extra',
            'extra',
            'extra',
            definition,
            rankedScope,
            generationOf('extra'),
          )
        ).ok,
      ).toBe(false);
      sockets.push(await socket(stub, 'token-0'), await socket(stub, 'token-0'));
      expect((await state(stub))?.phase).toBe('WAITING');
      for (let i = 1; i < count; i++) sockets.push(await socket(stub, `token-${i}`));
      expect((await state(stub))?.phase).toBe('REVEALING');
      expect(mocks.load).toHaveBeenCalledOnce();
      expect(await stub.cancelReservation('actor-0')).toBe(false);
      expect(
        (
          await stub.reserve(
            matchIdOf(stub),
            'new-actor',
            'N',
            'new',
            definition,
            rankedScope,
            generationOf('new-actor'),
          )
        ).ok,
      ).toBe(false);
      await evictDurableObject(stub);
      expect((await state(stub))?.players).toHaveLength(count);
    } finally {
      for (const connection of sockets) connection.close();
    }
  },
);

it('M01: cancellation frees slots and invalidates the old cookie before a replacement joins', async () => {
  const stub = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
  await stub.reserve(
    matchIdOf(stub),
    'a',
    'A',
    'old',
    definition,
    rankedScope,
    generationOf('a'),
  );
  expect(await stub.cancelReservation('a')).toBe(true);
  expect((await stub.lobbyStatus())?.actors).toEqual([]);
  expect(
    (
      await stub.fetch('https://game.test', {
        headers: {
          Upgrade: 'websocket',
          'X-Game-Session': 'old',
          'X-Game-Instance': rankedScope.id,
        },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await stub.reserve(
        matchIdOf(stub),
        'b',
        'B',
        'new',
        definition,
        rankedScope,
        generationOf('b'),
      )
    ).ok,
  ).toBe(true);
});

it.each(['ranked', 'casual'] as const)(
  '%sの待機は最後の接続切れで世代ごと解除し、他タブ接続中は保持する',
  async (kind) => {
    definition.kind = kind;
    const room = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
    await room.reserve(
      matchIdOf(room),
      'a',
      'A',
      'token-a',
      definition,
      rankedScope,
      'generation-a',
    );
    const firstSocket = await socket(room, 'token-a'),
      secondSocket = await socket(room, 'token-a');
    try {
      await runInDurableObject(room, async (instance, ctx) =>
        instance.webSocketClose(ctx.getWebSockets()[0]),
      );
      expect((await room.lobbyStatus())?.actors).toEqual(['a']);
      expect((await state(room))?.players[0].connected).toBe(true);
      await runInDurableObject(room, async (instance, ctx) => {
        const live = ctx
          .getWebSockets()
          .find((ws) => (ws.deserializeAttachment() as { live: boolean }).live);
        if (!live) throw new Error('live socket');
        await instance.webSocketClose(live);
      });
      expect((await room.lobbyStatus())?.actors).toEqual([]);
      expect((await state(room))?.result).toBeNull();
      await evictDurableObject(room);
      expect(
        await room.reserve(
          matchIdOf(room),
          'a',
          'A',
          'token-a',
          definition,
          rankedScope,
          'generation-a',
        ),
      ).toMatchObject({ ok: false });
    } finally {
      firstSocket.close();
      secondSocket.close();
    }
  },
);

it('部屋ID未確定の取消を参加前・DB読込中に保存し、後発の別操作を巻き込まない', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = crypto.randomUUID();
  expect(await queue.cancelAdmission('a', first, rankedScope.id)).toMatchObject({
    ok: true,
  });
  expect(await queue.enter('a', 'A', false, rankedScope, false, first)).toMatchObject({
    ok: false,
    code: 'STALE_REQUEST',
  });
  let released = false;
  let started = false;
  mocks.load.mockImplementationOnce(async () => {
    started = true;
    while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
    return structuredClone(definition);
  });
  const slow = crypto.randomUUID(),
    fast = crypto.randomUUID();
  const pending = queue.enter('a', 'A', false, rankedScope, false, slow);
  await vi.waitFor(() => expect(started).toBe(true));
  expect(await queue.cancelAdmission('a', slow, rankedScope.id)).toMatchObject({
    ok: true,
  });
  const successor = await queue.enter('a', 'A', false, rankedScope, false, fast);
  released = true;
  expect(await pending).toMatchObject({ ok: false, code: 'STALE_REQUEST' });
  expect(successor.ok).toBe(true);
  expect(await queue.enter('a', '', true, rankedScope)).toEqual(successor);
});

it('切断済み待機者の古い台帳は、新参加者2人の同じ待機先への割当を妨げない', async () => {
  definition.playersPerMatch = 2;
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const old = await queue.enter('old', 'Old', false, rankedScope);
  if (!old.ok) throw new Error(old.code);
  const room = runtime.GAME_ROOM.getByName(`match:${old.room}`);
  const oldSocket = await socket(room, old.token);
  await runInDurableObject(room, async (instance, ctx) =>
    instance.webSocketClose(ctx.getWebSockets()[0]),
  );
  const firstAdmission = await queue.enter('a', 'A', false, rankedScope),
    secondAdmission = await queue.enter('b', 'B', false, rankedScope);
  if (!firstAdmission.ok || !secondAdmission.ok) throw new Error('setup');
  expect(secondAdmission.room).toBe(firstAdmission.room);
  const current = runtime.GAME_ROOM.getByName(`match:${firstAdmission.room}`);
  const connections = [
    await socket(current, firstAdmission.token),
    await socket(current, secondAdmission.token),
  ];
  try {
    expect((await state(current))?.phase).toBe('REVEALING');
  } finally {
    oldSocket.close();
    for (const ws of connections) ws.close();
  }
});

it('切替中の旧待機も操作IDで閉じ、後発予約拒否で旧待機を復活させない', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const oldOperation = crypto.randomUUID();
  const old = await queue.enter('a', 'A', false, rankedScope, false, oldOperation);
  if (!old.ok) throw new Error(old.code);
  let release = false,
    entered = false;
  let restore = () => {};
  await runInDurableObject(queue, async (instance) => {
    const target = instance as unknown as {
      room(id: string): DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>;
    };
    const original = target.room.bind(target);
    const spy = vi.spyOn(target, 'room').mockImplementation((id) =>
      id === old.room
        ? original(id)
        : ({
            reserve: async () => {
              entered = true;
              while (!release) await new Promise((done) => setTimeout(done, 5));
              return { ok: false, code: 'ROOM_CLOSED' };
            },
          } as unknown as ReturnType<typeof original>),
    );
    restore = () => spy.mockRestore();
  });
  const pending = queue.enter('a', 'A', false, rankedScope, false, crypto.randomUUID());
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(await queue.cancelAdmission('a', oldOperation, rankedScope.id)).toMatchObject({
      ok: true,
    });
    expect(
      (await runtime.GAME_ROOM.getByName(`match:${old.room}`).lobbyStatus())?.actors,
    ).toEqual([]);
  } finally {
    release = true;
  }
  await pending;
  restore();
  expect(await queue.enter('a', '', true, rankedScope)).toMatchObject({
    ok: false,
    code: 'NO_ACTIVE_MATCH',
  });
});

it('取消応答が失われても同じ操作は復活せず、開始済みなら取消せず復帰できる', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const operationId = crypto.randomUUID();
  const first = await queue.enter('a', 'A', false, rankedScope, false, operationId);
  if (!first.ok) throw new Error(first.code);
  expect(await queue.cancelAdmission('a', operationId, rankedScope.id)).toMatchObject({
    ok: true,
  });
  await evictDurableObject(queue);
  expect(await queue.cancelAdmission('a', operationId, rankedScope.id)).toMatchObject({
    ok: true,
  });
  expect(
    await queue.enter('a', 'A', false, rankedScope, false, operationId),
  ).toMatchObject({ ok: false, code: 'STALE_REQUEST' });
  definition.playersPerMatch = 2;
  const startedOperation = crypto.randomUUID();
  const next = await queue.enter('a', 'A', false, rankedScope, false, startedOperation);
  const other = await queue.enter('b', 'B', false, rankedScope);
  if (!next.ok || !other.ok) throw new Error('setup');
  const room = runtime.GAME_ROOM.getByName(`match:${next.room}`);
  const firstSocket = await socket(room, next.token),
    secondSocket = await socket(room, other.token);
  try {
    expect(
      await queue.cancelAdmission('a', startedOperation, rankedScope.id),
    ).toMatchObject({
      ok: false,
      code: 'MATCH_STARTED',
    });
    expect((await state(room))?.players[0].forfeited).toBeUndefined();
    expect(await queue.enter('a', '', true, rankedScope)).toEqual(next);
    await runInDurableObject(room, async (instance, ctx) => {
      const ws = ctx
        .getWebSockets()
        .find(
          (ws) => (ws.deserializeAttachment() as { actorId: string }).actorId === 'a',
        );
      if (!ws) throw new Error('socket');
      await instance.webSocketClose(ws);
    });
    expect((await state(room))?.reconnect?.deadline).toBeGreaterThan(Date.now());
    expect((await state(room))?.result).toBeNull();
  } finally {
    firstSocket.close();
    secondSocket.close();
  }
});

it('待機取消のDO応答消失は閉鎖世代を保持し、再起動後のAlarmで同じ取消を完了する', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const operationId = crypto.randomUUID();
  const admitted = await queue.enter('a', 'A', false, rankedScope, false, operationId);
  if (!admitted.ok) throw new Error(admitted.code);
  let restore = () => {};
  await runInDurableObject(queue, async (instance) => {
    const target = instance as unknown as {
      room(id: string): DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>;
    };
    const original = target.room.bind(target);
    const spy = vi.spyOn(target, 'room').mockImplementation((id) => {
      const actual = original(id);
      return {
        cancelReservation: async (
          ...args: Parameters<typeof actual.cancelReservation>
        ) => {
          await actual.cancelReservation(...args);
          throw new Error('response lost');
        },
      } as unknown as typeof actual;
    });
    restore = () => spy.mockRestore();
  });
  try {
    expect(await queue.cancelAdmission('a', operationId, rankedScope.id)).toMatchObject({
      ok: false,
      code: 'GAME_DATABASE_UNAVAILABLE',
    });
  } finally {
    restore();
  }
  await runInDurableObject(queue, async (_instance, ctx) => {
    const receipts =
      await ctx.storage.get<Record<string, { expires: number; cancelling?: unknown }>>(
        'admissions:a',
      );
    if (!receipts) throw new Error('receipt');
    receipts[operationId].expires = Date.now() - 1;
    await ctx.storage.put('admissions:a', receipts);
  });
  const next = await queue.enter(
    'a',
    'A',
    false,
    rankedScope,
    false,
    crypto.randomUUID(),
  );
  if (!next.ok) throw new Error(next.code);
  expect(
    await runInDurableObject(
      queue,
      async (_instance, ctx) =>
        (
          await ctx.storage.get<Record<string, { cancelling?: unknown }>>('admissions:a')
        )?.[operationId]?.cancelling,
    ),
  ).toBeDefined();
  expect(
    await queue.enter('a', 'A', false, rankedScope, false, operationId),
  ).toMatchObject({ ok: false, code: 'STALE_REQUEST' });
  await evictDurableObject(queue);
  await runDurableObjectAlarm(queue);
  expect(await queue.enter('a', '', true, rankedScope)).toMatchObject({
    ok: true,
    room: next.room,
  });
  expect(
    (await state(runtime.GAME_ROOM.getByName(`match:${admitted.room}`)))?.result,
  ).toBeNull();
  await queue.cancel('a', next.room, false, rankedScope.id);
});

it('M01/G14: failed DB revalidation cannot start or expose a question', async () => {
  definition.playersPerMatch = 2;
  const stub = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
  await stub.reserve(
    matchIdOf(stub),
    'a',
    'A',
    'a',
    definition,
    rankedScope,
    generationOf('a'),
  );
  await stub.reserve(
    matchIdOf(stub),
    'b',
    'B',
    'b',
    definition,
    rankedScope,
    generationOf('b'),
  );
  const connection = await socket(stub, 'a');
  try {
    mocks.load.mockRejectedValueOnce(new Error('DB_OFFLINE'));
    expect(
      (
        await stub.fetch('https://game.test', {
          headers: {
            Upgrade: 'websocket',
            'X-Game-Session': 'b',
            'X-Game-Instance': rankedScope.id,
          },
        })
      ).status,
    ).toBe(503);
    expect((await state(stub))?.phase).toBe('WAITING');
    expect((await state(stub))?.revealed).toBe(0);
    mocks.load.mockRejectedValueOnce(new Error('DEFINITION_NOT_FOUND'));
    await stub.fetch('https://game.test', {
      headers: {
        Upgrade: 'websocket',
        'X-Game-Session': 'b',
        'X-Game-Instance': rankedScope.id,
      },
    });
    expect((await stub.lobbyStatus())?.closed).toBe(true);
  } finally {
    connection.close();
  }
});

it('M01: unconnected reservation and hard waiting lifetime survive eviction and expire via alarm', async () => {
  const stub = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
  await stub.reserve(
    matchIdOf(stub),
    'a',
    'A',
    'a',
    definition,
    rankedScope,
    generationOf('a'),
  );
  await runInDurableObject(stub, async (_instance, ctx) => {
    const room = await ctx.storage.get<{
      lobby: { reservations: Record<string, number> };
    }>('room');
    if (!room) throw new Error('room');
    room.lobby.reservations.a = Date.now() - 1;
    await ctx.storage.put('room', room);
  });
  await evictDurableObject(stub);
  await runDurableObjectAlarm(stub);
  expect((await stub.lobbyStatus())?.actors).toHaveLength(0);
  await runInDurableObject(stub, async (_instance, ctx) => {
    const room = await ctx.storage.get<{ lobby: { expires: number } }>('room');
    if (!room) throw new Error('room');
    room.lobby.expires = Date.now() - 1;
    await ctx.storage.put('room', room);
  });
  await runDurableObjectAlarm(stub);
  expect((await stub.lobbyStatus())?.closed).toBe(true);
});

it('M01/M03: matching is idempotent on resume, rejects duplicate join, and isolates definition versions', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = await queue.enter('a', 'A', false, rankedScope);
  if (!first.ok) throw new Error(first.code);
  expect((await queue.enter('a', 'A', false, rankedScope)).ok).toBe(false);
  await evictDurableObject(queue);
  expect(await queue.enter('a', '', true, rankedScope)).toEqual(first);
  const second = await queue.enter('b', 'B', false, rankedScope);
  if (!second.ok) throw new Error(second.code);
  expect(second.room).toBe(first.room);
  mocks.load.mockResolvedValueOnce({
    ...structuredClone(definition),
    competition: { ...definition.competition, version: 2 },
  });
  const other = await queue.enter('c', 'C', false, rankedScope);
  if (!other.ok) throw new Error(other.code);
  expect(other.room).not.toBe(first.room);
  expect((await queue.cancel('a', 'wrong-room', false, rankedScope.id)).ok).toBe(false);
  expect((await queue.cancel('a', first.room, false, rankedScope.id)).ok).toBe(true);
  expect((await queue.enter('a', '', true, rankedScope)).ok).toBe(false);
});

it('A04: identity is server verified; unauthenticated and cross-origin requests fail before matching', async () => {
  const bindings = runtime;
  expect(
    (
      await app.request(
        'https://game.test/api/matchmaking/join',
        { method: 'POST', headers: { Origin: owner }, body: '{}' },
        bindings,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await app.request(
        'https://game.test/api/matchmaking/socket?room=bad',
        { headers: { Origin: 'https://evil.test' } },
        bindings,
      )
    ).status,
  ).toBe(403);
  mocks.identity.mockResolvedValueOnce(null);
  expect(
    (
      await app.request(
        'https://game.test/api/matchmaking/resume',
        {
          method: 'POST',
          headers: { Origin: owner, Authorization: 'Bearer bad' },
          body: '{}',
        },
        bindings,
      )
    ).status,
  ).toBe(401);
  const response = await app.request(
    'https://game.test/api/matchmaking/join',
    {
      method: 'POST',
      headers: { Origin: owner, Authorization: 'Bearer valid' },
      body: JSON.stringify({ actorId: 'forged' }),
    },
    bindings,
  );
  expect(response.status).toBe(400);
});

it('M01: concurrent queue admissions never exceed capacity or create duplicate memberships', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const admissions = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      queue.enter(`actor-${i}`, `P${i}`, false, rankedScope),
    ),
  );
  const counts = new Map<string, number>();
  for (const result of admissions) {
    if (!result.ok) throw new Error(result.code);
    counts.set(result.room, (counts.get(result.room) ?? 0) + 1);
  }
  expect([...counts.values()].sort()).toEqual([2, 4, 4]);
  const duplicates = await Promise.all([
    queue.enter('duplicate', 'D', false, rankedScope),
    queue.enter('duplicate', 'D', false, rankedScope),
  ]);
  expect(duplicates.filter((result) => result.ok)).toHaveLength(1);
});

it('M01: lost reservation response resumes the persisted room/token after eviction', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const room = crypto.randomUUID();
  await runInDurableObject(queue, async (_instance, ctx) => {
    await ctx.storage.put('queue', {
      ...emptyQueue(),
      actors: {
        a: {
          created: Date.now(),
          room,
          token: 'pending-token',
          generation: 'pending-generation',
          name: 'A',
          guest: false,
          key: JSON.stringify([rankedScope.id, 'ranked', definition.competition]),
          pending: definition,
          scope: rankedScope,
        },
      },
    });
  });
  await evictDurableObject(queue);
  const result = await queue.enter('a', '', true, rankedScope);
  expect(result).toMatchObject({ ok: true, room, token: 'pending-token' });
  expect(
    (await runtime.GAME_ROOM.getByName(`match:${room}`).lobbyStatus())?.actors,
  ).toEqual(['a']);
});

it('M01: cancellation racing the final connection has a single outcome', async () => {
  definition.playersPerMatch = 2;
  const stub = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
  await stub.reserve(
    matchIdOf(stub),
    'a',
    'A',
    'a',
    definition,
    rankedScope,
    generationOf('a'),
  );
  await stub.reserve(
    matchIdOf(stub),
    'b',
    'B',
    'b',
    definition,
    rankedScope,
    generationOf('b'),
  );
  const first = await socket(stub, 'a');
  let last: WebSocket | undefined;
  try {
    const [response, cancelled] = await Promise.all([
      stub.fetch('https://game.test', {
        headers: {
          Upgrade: 'websocket',
          'X-Game-Session': 'b',
          'X-Game-Instance': rankedScope.id,
        },
      }),
      stub.cancelReservation('a'),
    ]);
    last = response.webSocket ?? undefined;
    last?.accept();
    const current = await state(stub);
    expect(current?.phase).toBe(cancelled ? 'WAITING' : 'REVEALING');
    expect(current?.players.length).toBe(cancelled ? 1 : 2);
  } finally {
    first.close();
    last?.close();
  }
});

it('A04: logout revokes old sockets/cookies and authenticated resume restores the same actor', async () => {
  definition.playersPerMatch = 2;
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const firstAdmission = await queue.enter('a', 'A', false, rankedScope);
  const secondAdmission = await queue.enter('b', 'B', false, rankedScope);
  if (!firstAdmission.ok || !secondAdmission.ok) throw new Error('join');
  const stub = runtime.GAME_ROOM.getByName(`match:${firstAdmission.room}`);
  const first = await socket(stub, firstAdmission.token);
  const second = await socket(stub, secondAdmission.token);
  try {
    expect((await queue.cancel('a', firstAdmission.room, true, rankedScope.id)).ok).toBe(
      true,
    );
    expect(
      (
        await stub.fetch('https://game.test', {
          headers: {
            Upgrade: 'websocket',
            'X-Game-Session': firstAdmission.token,
            'X-Game-Instance': rankedScope.id,
          },
        })
      ).status,
    ).toBe(401);
    const resumed = await queue.enter('a', '', true, rankedScope);
    if (!resumed.ok) throw new Error(resumed.code);
    expect(resumed.room).toBe(firstAdmission.room);
    expect(resumed.token).not.toBe(firstAdmission.token);
    expect((await state(stub))?.players).toHaveLength(2);
  } finally {
    first.close();
    second.close();
  }
});

it('A04: public Auth settings need no probe token; join issues HttpOnly session without disclosing game data', async () => {
  const bindings = { ...runtime, PROBES_ENABLED: 'false' };
  const config = await app.request('https://game.test/api/auth/config', {}, bindings);
  expect(config.status).toBe(200);
  expect(Object.keys(await config.json()).sort()).toEqual(['publishableKey']);
  const response = await app.request(
    'https://game.test/api/matchmaking/join',
    {
      method: 'POST',
      headers: { Origin: owner, Authorization: 'Bearer valid' },
      body: '{}',
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('SameSite=Strict');
  expect(Object.keys(await response.json())).toEqual(['room']);
  expect(mocks.identity.mock.lastCall?.[0].headers.get('Authorization')).toBe(
    'Bearer valid',
  );
  const duplicate = await app.request(
    'https://game.test/api/matchmaking/join',
    {
      method: 'POST',
      headers: { Origin: owner, Authorization: 'Bearer valid' },
      body: '{}',
    },
    bindings,
  );
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({ code: 'ALREADY_JOINED' });
});

it.each<[string, number, () => Promise<null>]>([
  ['rejected account', 401, async () => null],
  [
    'unavailable identity provider',
    503,
    async () => {
      throw new Error('offline');
    },
  ],
])('A04: rejects joins when Clerk reports a %s', async (_case, status, verify) => {
  mocks.identity.mockImplementation(verify);
  const response = await app.request(
    'https://game.test/api/matchmaking/join',
    {
      method: 'POST',
      headers: { Origin: 'https://game.test', Authorization: 'Bearer invalid' },
      body: '{}',
    },
    runtime,
  );
  expect(response.status).toBe(status);
  expect(mocks.load).not.toHaveBeenCalled();
});

it('review: heartbeats sent during slow DB revalidation keep the waiting player connected', async () => {
  definition.playersPerMatch = 2;
  const stub = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
  await stub.reserve(
    matchIdOf(stub),
    'a',
    'A',
    'a',
    definition,
    rankedScope,
    generationOf('a'),
  );
  await stub.reserve(
    matchIdOf(stub),
    'b',
    'B',
    'b',
    definition,
    rankedScope,
    generationOf('b'),
  );
  const first = await socket(stub, 'a');
  const heartbeat = setInterval(
    () => first.send(JSON.stringify({ type: 'sync', matchId: null, lastSeq: null })),
    1000,
  );
  let last: WebSocket | undefined;
  try {
    mocks.load.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16000));
      return structuredClone(definition);
    });
    const response = await stub.fetch('https://game.test', {
      headers: {
        Upgrade: 'websocket',
        'X-Game-Session': 'b',
        'X-Game-Instance': rankedScope.id,
      },
    });
    last = response.webSocket ?? undefined;
    last?.accept();
    expect((await state(stub))?.phase).toBe('REVEALING');
  } finally {
    clearInterval(heartbeat);
    first.close();
    last?.close();
  }
}, 25000);

it.each(['cancel-requester', 'cancel-peer', 'expire', 'another-start'])(
  'DB revalidation rechecks current room after %s',
  async (scenario) => {
    definition.playersPerMatch = 2;
    const stub = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
    await stub.reserve(
      matchIdOf(stub),
      'a',
      'A',
      'a',
      definition,
      rankedScope,
      generationOf('a'),
    );
    await stub.reserve(
      matchIdOf(stub),
      'b',
      'B',
      'b',
      definition,
      rankedScope,
      generationOf('b'),
    );
    const first = await socket(stub, 'a');
    let released = false;
    let failure: Error | undefined;
    mocks.load.mockImplementationOnce(async () => {
      while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
      if (failure) throw failure;
      return structuredClone(definition);
    });
    const pending = stub.fetch('https://game.test', {
      headers: {
        Upgrade: 'websocket',
        'X-Game-Session': 'b',
        'X-Game-Instance': rankedScope.id,
      },
    });
    let last: WebSocket | undefined;
    let concurrent: WebSocket | undefined;
    try {
      await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
      if (scenario.startsWith('cancel'))
        expect(
          await stub.cancelReservation(scenario === 'cancel-requester' ? 'b' : 'a'),
        ).toBe(true);
      if (scenario === 'expire')
        await runInDurableObject(stub, async (_instance, ctx) => {
          const room = await ctx.storage.get<{ lobby: { expires: number } }>('room');
          if (!room) throw new Error('room');
          room.lobby.expires = Date.now() - 1;
          await ctx.storage.put('room', room);
        });
      if (scenario === 'another-start') {
        concurrent = await socket(stub, 'b');
        failure = new Error('DEFINITION_NOT_FOUND');
      }
      released = true;
      const response = await pending;
      last = response.webSocket ?? undefined;
      last?.accept();
      expect(response.status).toBe(
        ['expire', 'cancel-requester'].includes(scenario) ? 401 : 101,
      );
      const current = await state(stub);
      expect(current?.phase).toBe(scenario === 'another-start' ? 'REVEALING' : 'WAITING');
      if (scenario.startsWith('cancel')) expect(current?.players).toHaveLength(1);
    } finally {
      released = true;
      first.close();
      last?.close();
      concurrent?.close();
    }
  },
);

it('DB admission wait allows another actor to resume and cancel before the DB responds', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = await queue.enter('a', 'A', false, rankedScope);
  if (!first.ok) throw new Error(first.code);
  let released = false;
  let started = false;
  mocks.load.mockImplementationOnce(async () => {
    started = true;
    while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
    return structuredClone(definition);
  });
  const pending = queue.enter('b', 'B', false, rankedScope);
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    expect(await queue.enter('a', '', true, rankedScope)).toEqual(first);
    expect((await queue.cancel('a', first.room, false, rankedScope.id)).ok).toBe(true);
    expect(
      (await runtime.GAME_ROOM.getByName(`match:${first.room}`).lobbyStatus())?.actors,
    ).toEqual([]);
    await runDurableObjectAlarm(queue);
  } finally {
    released = true;
  }
  expect((await pending).ok).toBe(true);
  expect((await queue.enter('a', '', true, rankedScope)).ok).toBe(false);
});

it('DB admission rechecks a membership created by a later request for the same actor', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  let released = false;
  let started = false;
  mocks.load.mockImplementationOnce(async () => {
    started = true;
    while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
    return structuredClone(definition);
  });
  const pending = queue.enter('a', 'Slow', false, rankedScope);
  let completed: Awaited<typeof pending>;
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    completed = await queue.enter('a', 'Fast', false, rankedScope);
    expect(completed.ok).toBe(true);
  } finally {
    released = true;
  }
  expect(await pending).toEqual({ ok: false, code: 'ALREADY_JOINED' });
  if (!completed.ok) throw new Error(completed.code);
  expect(await queue.enter('a', '', true, rankedScope)).toEqual(completed);
  expect(
    (await runtime.GAME_ROOM.getByName(`match:${completed.room}`).lobbyStatus())?.actors,
  ).toEqual(['a']);
});

it('failed DB admissions retain rate accounting without blocking later resume', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = await queue.enter('a', 'A', false, rankedScope);
  mocks.load.mockRejectedValueOnce(new Error('database offline'));
  expect(await queue.enter('b', 'B', false, rankedScope)).toEqual({
    ok: false,
    code: 'GAME_DATABASE_UNAVAILABLE',
  });
  expect(await queue.enter('a', '', true, rankedScope)).toEqual(first);
  await runInDurableObject(queue, async (_instance, ctx) => {
    const saved = await ctx.storage.get<{ rates: Record<string, { count: number }> }>(
      'queue',
    );
    expect(saved?.rates.b.count).toBe(1);
    expect(saved?.rates.a.count).toBe(2);
  });
});

it('DB admission failure returns HTTP 503 without issuing a room cookie', async () => {
  mocks.load.mockRejectedValueOnce(new Error('database offline'));
  const response = await app.request(
    'https://game.test/api/matchmaking/join',
    {
      method: 'POST',
      headers: { Origin: owner, Authorization: 'Bearer valid' },
      body: '{}',
    },
    runtime,
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 'GAME_DATABASE_UNAVAILABLE' });
  expect(response.headers.get('set-cookie')).toBeNull();
});

it('a stale DB response cannot recreate membership after a newer admission is cancelled', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  let released = false;
  let started = false;
  mocks.load.mockImplementationOnce(async () => {
    started = true;
    while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
    return structuredClone(definition);
  });
  const pending = queue.enter('a', 'Slow', false, rankedScope);
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    const fast = await queue.enter('a', 'Fast', false, rankedScope);
    if (!fast.ok) throw new Error(fast.code);
    expect((await queue.cancel('a', fast.room, false, rankedScope.id)).ok).toBe(true);
  } finally {
    released = true;
  }
  expect(await pending).toEqual({ ok: false, code: 'STALE_REQUEST' });
  expect(await queue.enter('a', '', true, rankedScope)).toEqual({
    ok: false,
    code: 'NO_ACTIVE_MATCH',
  });
});

it('組織内A/Bの同時参加は一つ、他のactorの待機列はインスタンス別', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const firstCompetition = { id: crypto.randomUUID(), owner };
  const secondCompetition = { id: crypto.randomUUID(), owner };
  const results = await Promise.all([
    queue.enter('same', 'S', false, firstCompetition),
    queue.enter('same', 'S', false, secondCompetition),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  const first = await queue.enter('first', 'A', false, firstCompetition);
  const second = await queue.enter('second', 'B', false, secondCompetition);
  if (!first.ok || !second.ok) throw new Error('join');
  expect(first.room).not.toBe(second.room);
  expect(await queue.enter('first', '', true, secondCompetition)).toMatchObject({
    ok: false,
    code: 'OTHER_INSTANCE_ACTIVE',
    instanceId: firstCompetition.id,
  });
  expect(
    await queue.cancel('first', first.room, false, secondCompetition.id),
  ).toMatchObject({
    ok: false,
  });
  await evictDurableObject(queue);
  expect(await queue.enter('first', '', true, firstCompetition)).toEqual(first);
});

it('取消済みの世代は、部屋が未作成でも遅延した予約を再成立させない', async () => {
  const room = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
  const scope = { id: crypto.randomUUID(), owner };
  expect(await room.cancelReservation('a', false, 'old-generation')).toBe(true);
  await evictDurableObject(room);
  expect(
    await room.reserve(
      matchIdOf(room),
      'a',
      'A',
      'old-token',
      definition,
      scope,
      'old-generation',
    ),
  ).toEqual({ ok: false, code: 'STALE_RESERVATION' });
  expect(
    (
      await room.reserve(
        matchIdOf(room),
        'a',
        'A',
        'new-token',
        definition,
        scope,
        'new-generation',
      )
    ).ok,
  ).toBe(true);
  expect(await room.cancelReservation('a', false, 'old-generation')).toBe(false);
  expect((await room.lobbyStatus())?.actors).toEqual(['a']);
});

it('部屋トークンは別インスタンスIDのWebSocketに使えない', async () => {
  const room = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
  const scope = { id: crypto.randomUUID(), owner };
  await room.reserve(matchIdOf(room), 'a', 'A', 'token', definition, scope, 'generation');
  expect(
    (
      await room.reserve(
        matchIdOf(room),
        'b',
        'B',
        'other',
        definition,
        { ...scope, id: crypto.randomUUID() },
        'other',
      )
    ).ok,
  ).toBe(false);
  const response = await room.fetch('https://game.test', {
    headers: {
      Upgrade: 'websocket',
      'X-Game-Session': 'token',
      'X-Game-Instance': crypto.randomUUID(),
    },
  });
  expect(response.status).toBe(403);
  const accepted = await room.fetch('https://game.test', {
    headers: {
      Upgrade: 'websocket',
      'X-Game-Session': 'token',
      'X-Game-Instance': scope.id,
    },
  });
  expect(accepted.status).toBe(101);
  accepted.webSocket?.accept();
  accepted.webSocket?.close();
});

it('終端後に未保存結果を残したまま組織参加枠を解放する', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const firstCompetition = { id: crypto.randomUUID(), owner };
  const secondCompetition = { id: crypto.randomUUID(), owner };
  const first = await queue.enter('a', 'A', false, firstCompetition);
  if (!first.ok) throw new Error(first.code);
  const room = runtime.GAME_ROOM.getByName(`match:${first.room}`);
  await runInDurableObject(room, async (_instance, ctx) => {
    const saved = await ctx.storage.get<{ state: State; resultRetryAt?: number }>('room');
    if (!saved) throw new Error('room');
    saved.state.phase = 'FINISHED';
    saved.state.deadline = null;
    saved.resultRetryAt = Date.now() + 60000;
    await ctx.storage.put('room', saved);
  });
  expect((await queue.enter('a', 'A', false, secondCompetition)).ok).toBe(true);
  expect((await state(room))?.phase).toBe('FINISHED');
});

it('候補0の検出で待機を解除し、候補復旧後は本人の再参加だけを受け付ける', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner };
  const first = await queue.enter('a', 'A', false, scope);
  if (!first.ok) throw new Error(first.code);
  mocks.load.mockRejectedValueOnce(new Error('NO_RANKED_QUESTIONS'));
  await runDurableObjectAlarm(queue);
  expect(
    (await runtime.GAME_ROOM.getByName(`match:${first.room}`).lobbyStatus())?.closed,
  ).toBe(true);
  expect(await queue.enter('a', '', true, scope)).toEqual({
    ok: false,
    code: 'NO_ACTIVE_MATCH',
  });
  const next = await queue.enter('a', 'A', false, scope);
  expect(next.ok).toBe(true);
  if (next.ok) expect(next.room).not.toBe(first.room);
});

it('候補0の待機解除は開始済みの固定問題や終端を変更しない', async () => {
  const room = runtime.GAME_ROOM.getByName(`match:${crypto.randomUUID()}`);
  const scope = { id: crypto.randomUUID(), owner };
  await room.reserve(matchIdOf(room), 'a', 'A', 'token', definition, scope, 'generation');
  await runInDurableObject(room, async (_instance, ctx) => {
    const saved = await ctx.storage.get<{ state: State }>('room');
    if (!saved) throw new Error('room');
    saved.state.phase = 'REVEALING';
    saved.state.deadline = Date.now() + 60000;
    await ctx.storage.put('room', saved);
  });
  expect(await room.stopWaiting(scope.id)).toBe(false);
  expect((await state(room))?.phase).toBe('REVEALING');
  expect((await state(room))?.questions).toEqual(definition.questions);
});

it('部屋照合が失敗しても別インスタンスへの参加枠を解放しない', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const firstCompetition = { id: crypto.randomUUID(), owner };
  const secondCompetition = { id: crypto.randomUUID(), owner };
  const first = await queue.enter('a', 'A', false, firstCompetition);
  if (!first.ok) throw new Error(first.code);
  let restore = () => {};
  await runInDurableObject(queue, async (instance) => {
    const spy = vi
      .spyOn(
        instance as unknown as { room(id: string): { lobbyStatus(): Promise<unknown> } },
        'room',
      )
      .mockReturnValue({
        lobbyStatus: async () => {
          throw new Error('RPC_RESPONSE_LOST');
        },
      });
    restore = () => spy.mockRestore();
  });
  try {
    expect(await queue.enter('a', 'A', false, secondCompetition)).toMatchObject({
      ok: false,
      code: 'OTHER_INSTANCE_ACTIVE',
    });
  } finally {
    restore();
  }
  expect(await queue.enter('a', '', true, firstCompetition)).toEqual(first);
});

it('レビューR01: logout応答消失中の復帰でも進行中の組織参加枠を保持する', async () => {
  definition.playersPerMatch = 2;
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner };
  const other = { id: crypto.randomUUID(), owner };
  const first = await queue.enter('a', 'A', false, scope);
  const second = await queue.enter('b', 'B', false, scope);
  if (!first.ok || !second.ok) throw new Error('setup');
  const room = runtime.GAME_ROOM.getByName(`match:${first.room}`);
  const connections: WebSocket[] = [];
  for (const entry of [first, second]) {
    const response = await room.fetch('https://game.test', {
      headers: {
        Upgrade: 'websocket',
        'X-Game-Session': entry.token,
        'X-Game-Instance': scope.id,
      },
    });
    if (!response.webSocket) throw new Error('socket');
    response.webSocket.accept();
    connections.push(response.webSocket);
  }
  let reached = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let restore = () => {};
  await runInDurableObject(queue, async (instance) => {
    const target = instance as unknown as { room(id: string): typeof room };
    const original = target.room.bind(target);
    const spy = vi.spyOn(target, 'room').mockImplementation((id) => {
      const actual = original(id);
      return {
        lobbyStatus: () => actual.lobbyStatus(),
        reserve: (...args: Parameters<typeof actual.reserve>) => actual.reserve(...args),
        cancelReservation: async (
          ...args: Parameters<typeof actual.cancelReservation>
        ) => {
          const result = await actual.cancelReservation(...args);
          if (args[1] && !reached) {
            reached = true;
            await barrier;
          }
          return result;
        },
      } as typeof room;
    });
    restore = () => spy.mockRestore();
  });
  const logout = queue.cancel('a', first.room, true, scope.id);
  try {
    await vi.waitFor(() => expect(reached).toBe(true));
    const resumed = await queue.enter('a', '', true, scope);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.token).not.toBe(first.token);
    expect(await queue.enter('a', 'A', false, other)).toMatchObject({
      ok: false,
      code: 'OTHER_INSTANCE_ACTIVE',
    });
    expect((await state(room))?.phase).toBe('REVEALING');
    expect((await state(room))?.players.map((player) => player.id)).toContain('a');
  } finally {
    release();
    await logout;
    restore();
    for (const connection of connections) connection.close();
  }
});

it.each(['room', 'organization'])(
  'レビューR02/R04: 終端回収後の%sログアウトも旧tokenを失効させる',
  async (kind) => {
    const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
    const first = await queue.enter('a', 'A', false, rankedScope);
    if (!first.ok) throw new Error(first.code);
    const room = runtime.GAME_ROOM.getByName(`match:${first.room}`);
    await runInDurableObject(room, async (_instance, ctx) => {
      const saved = await ctx.storage.get<{ state: State; resultRetryAt?: number }>(
        'room',
      );
      if (!saved) throw new Error('room');
      saved.state.phase = 'FINISHED';
      saved.state.deadline = null;
      saved.resultRetryAt = Date.now() + 60000;
      await ctx.storage.put('room', saved);
    });
    expect(await queue.enter('a', '', true, rankedScope)).toMatchObject({
      ok: false,
      code: 'NO_ACTIVE_MATCH',
    });
    await evictDurableObject(queue);
    expect(
      kind === 'room'
        ? await queue.cancel('a', first.room, true, rankedScope.id)
        : await queue.logoutActor('a'),
    ).toEqual({ ok: true });
    expect(
      (
        await room.fetch('https://game.test', {
          headers: {
            Upgrade: 'websocket',
            'X-Game-Session': first.token,
            'X-Game-Instance': rankedScope.id,
          },
        })
      ).status,
    ).toBe(401);
  },
);

it('レビューR03: 通常要求で回収期限を延ばさず、終了済み64室を回収して参加できる', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner };
  const before = Date.now() + 30000;
  let restore = () => {};
  await runInDurableObject(queue, async (instance, ctx) => {
    const actors = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [
        `old-${i}`,
        {
          room: crypto.randomUUID(),
          key: JSON.stringify([scope.id, definition.competition]),
          token: `token-${i}`,
          generation: `generation-${i}`,
          name: 'Old',
          guest: false,
          created: 0,
          scope,
        },
      ]),
    );
    await ctx.storage.put('queue', { ...emptyQueue(), actors });
    await ctx.storage.setAlarm(before);
    const oldRooms = new Set<string>(Object.values(actors).map((entry) => entry.room));
    const target = instance as unknown as {
      room(id: string): DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>;
    };
    const original = target.room.bind(target);
    const spy = vi.spyOn(target, 'room').mockImplementation((id) =>
      oldRooms.has(id)
        ? ({
            lobbyStatus: async () => ({
              phase: 'FINISHED',
              closed: true,
              actors: [],
              capacity: 4,
            }),
            cancelReservation: async () => true,
          } as unknown as ReturnType<typeof original>)
        : original(id),
    );
    restore = () => spy.mockRestore();
  });
  try {
    expect((await queue.enter('new', 'New', false, scope)).ok).toBe(true);
    expect(
      await runInDurableObject(queue, async (_instance, ctx) => ctx.storage.getAlarm()),
    ).toBe(before);
  } finally {
    restore();
  }
});

it('レビューR10: 故障した部屋を保持して、正常な別室への参加は受け付ける', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = await queue.enter('a', 'A', false, rankedScope);
  if (!first.ok) throw new Error(first.code);
  let restore = () => {};
  await runInDurableObject(queue, async (instance) => {
    const target = instance as unknown as {
      room(id: string): DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>;
    };
    const original = target.room.bind(target);
    const spy = vi.spyOn(target, 'room').mockImplementation((id) =>
      id === first.room
        ? ({
            lobbyStatus: async () => {
              throw new Error('ROOM_OFFLINE');
            },
          } as unknown as ReturnType<typeof original>)
        : original(id),
    );
    restore = () => spy.mockRestore();
  });
  try {
    const joined = await queue.enter('b', 'B', false, rankedScope);
    expect(joined.ok).toBe(true);
    if (joined.ok) expect(joined.room).not.toBe(first.room);
    expect(await queue.enter('a', 'A', false, rankedScope)).toMatchObject({
      ok: false,
      code: 'ALREADY_JOINED',
    });
  } finally {
    restore();
  }
});

it('DEV01: an older logout cannot release the admission lock of a pending newer logout', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const releases: Array<() => void> = [];
  let restore = () => {};
  await runInDurableObject(queue, async (instance) => {
    const target = instance as unknown as {
      room(id: string): DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>;
    };
    const original = target.room.bind(target);
    const spy = vi.spyOn(target, 'room').mockImplementation((id) =>
      id === 'receipt-room'
        ? ({
            cancelReservation: () =>
              new Promise<boolean>((resolve) => {
                releases.push(() => resolve(true));
              }),
          } as unknown as ReturnType<typeof original>)
        : original(id),
    );
    restore = () => spy.mockRestore();
  });
  await runInDurableObject(queue, async (instance) => {
    const first = instance.logoutActor('a', ['receipt-room']);
    let second: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      second = instance.logoutActor('a', ['receipt-room']);
      releases[0]();
      await first;
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      expect(await instance.enter('a', 'A', false, rankedScope)).toMatchObject({
        ok: false,
        code: 'LOGOUT_PENDING',
      });
      releases[1]();
      await second;
      expect((await instance.enter('a', 'A', false, rankedScope)).ok).toBe(true);
    } finally {
      for (const release of releases) release();
      await Promise.allSettled([first, second]);
      restore();
    }
  });
});

it('DEV01: failed logout remains blocked across eviction and a retry revokes the old token', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = await queue.enter('a', 'A', false, rankedScope);
  if (!first.ok) throw new Error(first.code);
  await runInDurableObject(queue, async (instance) => {
    const target = instance as unknown as {
      room(id: string): DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>;
    };
    const spy = vi.spyOn(target, 'room').mockImplementation(
      () =>
        ({
          cancelReservation: async () => {
            throw new Error('TEST_RPC_FAILURE');
          },
        }) as unknown as ReturnType<typeof target.room>,
    );
    try {
      await expect(instance.logoutActor('a')).rejects.toThrow('TEST_RPC_FAILURE');
    } finally {
      spy.mockRestore();
    }
  });
  await evictDurableObject(queue);
  expect(await queue.enter('a', 'A', false, rankedScope)).toMatchObject({
    ok: false,
    code: 'LOGOUT_PENDING',
  });
  expect(await queue.logoutActor('a')).toEqual({ ok: true });
  const room = runtime.GAME_ROOM.getByName(`match:${first.room}`);
  expect(
    (
      await room.fetch('https://game.test', {
        headers: {
          Upgrade: 'websocket',
          'X-Game-Session': first.token,
          'X-Game-Instance': rankedScope.id,
        },
      })
    ).status,
  ).toBe(401);
  expect((await queue.enter('a', 'A', false, rankedScope)).ok).toBe(true);
});

it('DEV02: maximum-size question definition persists without embedding it in the queue', async () => {
  const large = Array.from({ length: 100 }, (_, i) => ({
    ...definition.questions[0],
    id: `max-${i}`,
    text: '問'.repeat(2000),
    explanation: '解'.repeat(2000),
    source: '出'.repeat(1000),
    permission: '許'.repeat(1000),
  }));
  definition = await validateDefinition({
    ...definition,
    questions: large,
    manifestHash: await contentHash(large),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(definition)).length;
  const started = Date.now();
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const result = await queue.enter('a', 'A', false, rankedScope);
  expect(result.ok).toBe(true);
  const queueBytes = await runInDurableObject(
    queue,
    async (_instance, ctx) =>
      new TextEncoder().encode(JSON.stringify(await ctx.storage.get('queue'))).length,
  );
  expect(queueBytes).toBeLessThan(4096);
  await evictDurableObject(queue);
  expect(await queue.enter('a', '', true, rankedScope)).toEqual(result);
  console.log(
    JSON.stringify({
      check: 'DEV02 max definition',
      questions: 100,
      definitionBytes: bytes,
      queueBytes,
      elapsedMs: Date.now() - started,
    }),
  );
});

it('DEV02: rate-account capacity rejects overflow and recovers after expiry', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  await runInDurableObject(queue, async (_instance, ctx) => {
    await ctx.storage.put('queue', {
      ...emptyQueue(),
      rates: Object.fromEntries(
        Array.from({ length: 1024 }, (_, i) => [
          `actor-${i}`,
          { at: Date.now(), count: 1 },
        ]),
      ),
    });
  });
  expect(await queue.enter('overflow', 'New', false, rankedScope)).toEqual({
    ok: false,
    code: 'RATE_LIMIT',
  });
  await runInDurableObject(queue, async (_instance, ctx) => {
    const saved = await ctx.storage.get<{ rates: Record<string, { at: number }> }>(
      'queue',
    );
    if (!saved) throw Error('missing queue');
    for (const entry of Object.values(saved.rates)) entry.at = 0;
    console.log(
      JSON.stringify({
        check: 'DEV02 rate capacity',
        accounts: 1024,
        queueBytes: new TextEncoder().encode(JSON.stringify(saved)).length,
      }),
    );
    await ctx.storage.put('queue', saved);
  });
  expect((await queue.enter('overflow', 'New', false, rankedScope)).ok).toBe(true);
});
