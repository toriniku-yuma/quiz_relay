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

const mocks = vi.hoisted(() => ({ load: vi.fn(), user: vi.fn() }));
vi.mock('../src/worker/catalog/database', () => ({ loadMatchDefinition: mocks.load }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: mocks.user } }),
}));
const runtime: Env = { ...(env as unknown as Env), ORGANIZATION_ENABLED: 'false' };
const owner = 'https://game.test';
let definition: MatchDefinition;
beforeEach(async () => {
  mocks.load.mockReset();
  mocks.user.mockReset();
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
  mocks.load.mockImplementation(async (_env, ref) => ({
    ...structuredClone(definition),
    competition: ref ?? definition.competition,
  }));
  mocks.user.mockResolvedValue({
    data: { user: { id: 'user-1', email_confirmed_at: '2026-09-01' } },
    error: null,
  });
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
) {
  const response = await stub.fetch('https://game.test', {
    headers: { Upgrade: 'websocket', 'X-Game-Session': token },
  });
  if (!response.webSocket) throw new Error(`Upgrade failed ${response.status}`);
  response.webSocket.accept();
  return response.webSocket;
}

it.each([2, 3, 4])(
  'M01/M03: %i distinct connected actors start once; duplicate tabs and reservations do not start',
  async (count) => {
    definition.playersPerMatch = count;
    const stub = runtime.GAME_ROOM.getByName(crypto.randomUUID());
    const sockets: WebSocket[] = [];
    try {
      for (let i = 0; i < count; i++)
        expect(
          (await stub.reserve(`actor-${i}`, `P${i}`, `token-${i}`, definition)).ok,
        ).toBe(true);
      expect((await stub.reserve('extra', 'extra', 'extra', definition)).ok).toBe(false);
      sockets.push(await socket(stub, 'token-0'), await socket(stub, 'token-0'));
      expect((await state(stub))?.phase).toBe('WAITING');
      for (let i = 1; i < count; i++) sockets.push(await socket(stub, `token-${i}`));
      expect((await state(stub))?.phase).toBe('REVEALING');
      expect(mocks.load).toHaveBeenCalledOnce();
      expect(await stub.cancelReservation('actor-0')).toBe(false);
      expect((await stub.reserve('new-actor', 'N', 'new', definition)).ok).toBe(false);
      await evictDurableObject(stub);
      expect((await state(stub))?.players).toHaveLength(count);
    } finally {
      for (const connection of sockets) connection.close();
    }
  },
);

it('M01: cancellation frees slots and invalidates the old cookie before a replacement joins', async () => {
  const stub = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  await stub.reserve('a', 'A', 'old', definition);
  expect(await stub.cancelReservation('a')).toBe(true);
  expect((await stub.lobbyStatus())?.actors).toEqual([]);
  expect(
    (
      await stub.fetch('https://game.test', {
        headers: { Upgrade: 'websocket', 'X-Game-Session': 'old' },
      })
    ).status,
  ).toBe(401);
  expect((await stub.reserve('b', 'B', 'new', definition)).ok).toBe(true);
});

it('M01/G14: failed DB revalidation cannot start or expose a question', async () => {
  definition.playersPerMatch = 2;
  const stub = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  await stub.reserve('a', 'A', 'a', definition);
  await stub.reserve('b', 'B', 'b', definition);
  const connection = await socket(stub, 'a');
  try {
    mocks.load.mockRejectedValueOnce(new Error('DB_OFFLINE'));
    expect(
      (
        await stub.fetch('https://game.test', {
          headers: { Upgrade: 'websocket', 'X-Game-Session': 'b' },
        })
      ).status,
    ).toBe(503);
    expect((await state(stub))?.phase).toBe('WAITING');
    expect((await state(stub))?.revealed).toBe(0);
    mocks.load.mockRejectedValueOnce(new Error('QUESTION_UNAVAILABLE'));
    await stub.fetch('https://game.test', {
      headers: { Upgrade: 'websocket', 'X-Game-Session': 'b' },
    });
    expect((await stub.lobbyStatus())?.closed).toBe(true);
  } finally {
    connection.close();
  }
});

it('M01: unconnected reservation and hard waiting lifetime survive eviction and expire via alarm', async () => {
  const stub = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  await stub.reserve('a', 'A', 'a', definition);
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
  const first = await queue.enter('a', 'A', definition.competition);
  if (!first.ok) throw new Error(first.code);
  expect((await queue.enter('a', 'A', definition.competition)).ok).toBe(false);
  await evictDurableObject(queue);
  expect(await queue.enter('a', '', definition.competition, true)).toEqual(first);
  const second = await queue.enter('b', 'B', definition.competition);
  if (!second.ok) throw new Error(second.code);
  expect(second.room).toBe(first.room);
  const other = await queue.enter('c', 'C', { ...definition.competition, version: 2 });
  if (!other.ok) throw new Error(other.code);
  expect(other.room).not.toBe(first.room);
  expect((await queue.cancel('a', 'wrong-room')).ok).toBe(false);
  expect((await queue.cancel('a', first.room)).ok).toBe(true);
  expect((await queue.enter('a', '', definition.competition, true)).ok).toBe(false);
});

it('A04: identity is server verified; unauthenticated and cross-origin requests fail before matching', async () => {
  const bindings = {
    ...runtime,
    GAME_OWNER: owner,
    GAME_CONFIG_PROFILE: 'local',
  };
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
  mocks.user.mockResolvedValueOnce({ data: { user: null }, error: { status: 401 } });
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
      body: JSON.stringify({ name: 'A', actorId: 'forged' }),
    },
    bindings,
  );
  expect(response.status).toBe(400);
});

it('M01: concurrent queue admissions never exceed capacity or create duplicate memberships', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const admissions = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      queue.enter(`actor-${i}`, `P${i}`, definition.competition),
    ),
  );
  const counts = new Map<string, number>();
  for (const result of admissions) {
    if (!result.ok) throw new Error(result.code);
    counts.set(result.room, (counts.get(result.room) ?? 0) + 1);
  }
  expect([...counts.values()].sort()).toEqual([2, 4, 4]);
  const duplicates = await Promise.all([
    queue.enter('duplicate', 'D', definition.competition),
    queue.enter('duplicate', 'D', definition.competition),
  ]);
  expect(duplicates.filter((result) => result.ok)).toHaveLength(1);
});

it('M01: lost reservation response resumes the persisted room/token after eviction', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const room = crypto.randomUUID();
  await runInDurableObject(queue, async (_instance, ctx) => {
    await ctx.storage.put('queue', {
      rates: {},
      actors: {
        a: {
          created: Date.now(),
          room,
          token: 'pending-token',
          name: 'A',
          key: JSON.stringify(definition.competition),
          pending: definition,
        },
      },
    });
  });
  await evictDurableObject(queue);
  const result = await queue.enter('a', '', definition.competition, true);
  expect(result).toMatchObject({ ok: true, room, token: 'pending-token' });
  expect((await runtime.GAME_ROOM.getByName(`1c:${room}`).lobbyStatus())?.actors).toEqual(
    ['a'],
  );
});

it('M01: cancellation racing the final connection has a single outcome', async () => {
  definition.playersPerMatch = 2;
  const stub = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  await stub.reserve('a', 'A', 'a', definition);
  await stub.reserve('b', 'B', 'b', definition);
  const first = await socket(stub, 'a');
  let last: WebSocket | undefined;
  try {
    const [response, cancelled] = await Promise.all([
      stub.fetch('https://game.test', {
        headers: { Upgrade: 'websocket', 'X-Game-Session': 'b' },
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
  const a = await queue.enter('a', 'A', definition.competition);
  const b = await queue.enter('b', 'B', definition.competition);
  if (!a.ok || !b.ok) throw new Error('join');
  const stub = runtime.GAME_ROOM.getByName(`1c:${a.room}`);
  const first = await socket(stub, a.token);
  const second = await socket(stub, b.token);
  try {
    expect((await queue.cancel('a', a.room, true)).ok).toBe(true);
    expect(
      (
        await stub.fetch('https://game.test', {
          headers: { Upgrade: 'websocket', 'X-Game-Session': a.token },
        })
      ).status,
    ).toBe(401);
    const resumed = await queue.enter('a', '', definition.competition, true);
    if (!resumed.ok) throw new Error(resumed.code);
    expect(resumed.room).toBe(a.room);
    expect(resumed.token).not.toBe(a.token);
    expect((await state(stub))?.players).toHaveLength(2);
  } finally {
    first.close();
    second.close();
  }
});

it('A04: public Auth settings need no probe token; join issues HttpOnly session without disclosing game data', async () => {
  const bindings = {
    ...runtime,
    GAME_OWNER: owner,
    GAME_CONFIG_PROFILE: 'local',
    PROBES_ENABLED: 'false',
  };
  const config = await app.request('https://game.test/api/auth/config', {}, bindings);
  expect(config.status).toBe(200);
  expect(Object.keys(await config.json()).sort()).toEqual(['publishableKey', 'url']);
  const response = await app.request(
    'https://game.test/api/matchmaking/join',
    {
      method: 'POST',
      headers: { Origin: owner, Authorization: 'Bearer valid' },
      body: JSON.stringify({ name: 'A' }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('SameSite=Strict');
  expect(Object.keys(await response.json())).toEqual(['room']);
  expect(mocks.user).toHaveBeenCalledWith('valid');
  const duplicate = await app.request(
    'https://game.test/api/matchmaking/join',
    {
      method: 'POST',
      headers: { Origin: owner, Authorization: 'Bearer valid' },
      body: JSON.stringify({ name: 'different-name' }),
    },
    bindings,
  );
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({ code: 'ALREADY_JOINED' });
});

it.each([
  { id: 'anonymous', is_anonymous: true, email_confirmed_at: '2026-09-01' },
  { id: 'unconfirmed', is_anonymous: false, email_confirmed_at: null },
])('A04: rejects users without a confirmed non-anonymous identity', async (user) => {
  mocks.user.mockResolvedValue({ data: { user }, error: null });
  const response = await app.request(
    'https://game.test/api/matchmaking/join',
    {
      method: 'POST',
      headers: { Origin: 'https://game.test', Authorization: 'Bearer invalid' },
      body: JSON.stringify({ name: 'A' }),
    },
    runtime,
  );
  expect(response.status).toBe(401);
  expect(mocks.load).not.toHaveBeenCalled();
});

it('review: heartbeats sent during slow DB revalidation keep the waiting player connected', async () => {
  definition.playersPerMatch = 2;
  const stub = runtime.GAME_ROOM.getByName(`review-delay:${crypto.randomUUID()}`);
  await stub.reserve('a', 'A', 'a', definition);
  await stub.reserve('b', 'B', 'b', definition);
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
      headers: { Upgrade: 'websocket', 'X-Game-Session': 'b' },
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
    const stub = runtime.GAME_ROOM.getByName(crypto.randomUUID());
    await stub.reserve('a', 'A', 'a', definition);
    await stub.reserve('b', 'B', 'b', definition);
    const first = await socket(stub, 'a');
    let released = false;
    let failure: Error | undefined;
    mocks.load.mockImplementationOnce(async () => {
      while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
      if (failure) throw failure;
      return structuredClone(definition);
    });
    const pending = stub.fetch('https://game.test', {
      headers: { Upgrade: 'websocket', 'X-Game-Session': 'b' },
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
        failure = new Error('QUESTION_UNAVAILABLE');
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
  const first = await queue.enter('a', 'A', definition.competition);
  if (!first.ok) throw new Error(first.code);
  let released = false;
  let started = false;
  mocks.load.mockImplementationOnce(async () => {
    started = true;
    while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
    return structuredClone(definition);
  });
  const pending = queue.enter('b', 'B', definition.competition);
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    expect(await queue.enter('a', '', definition.competition, true)).toEqual(first);
    expect((await queue.cancel('a', first.room)).ok).toBe(true);
    expect(
      (await runtime.GAME_ROOM.getByName(`1c:${first.room}`).lobbyStatus())?.actors,
    ).toEqual([]);
    await runDurableObjectAlarm(queue);
  } finally {
    released = true;
  }
  expect((await pending).ok).toBe(true);
  expect((await queue.enter('a', '', definition.competition, true)).ok).toBe(false);
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
  const pending = queue.enter('a', 'Slow', definition.competition);
  let completed: Awaited<typeof pending>;
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    completed = await queue.enter('a', 'Fast', definition.competition);
    expect(completed.ok).toBe(true);
  } finally {
    released = true;
  }
  expect(await pending).toEqual({ ok: false, code: 'ALREADY_JOINED' });
  if (!completed.ok) throw new Error(completed.code);
  expect(await queue.enter('a', '', definition.competition, true)).toEqual(completed);
  expect(
    (await runtime.GAME_ROOM.getByName(`1c:${completed.room}`).lobbyStatus())?.actors,
  ).toEqual(['a']);
});

it('failed DB admissions retain rate accounting without blocking later resume', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = await queue.enter('a', 'A', definition.competition);
  mocks.load.mockRejectedValueOnce(new Error('database offline'));
  expect(await queue.enter('b', 'B', definition.competition)).toEqual({
    ok: false,
    code: 'GAME_DATABASE_UNAVAILABLE',
  });
  expect(await queue.enter('a', '', definition.competition, true)).toEqual(first);
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
      body: JSON.stringify({ name: 'A' }),
    },
    { ...runtime, GAME_OWNER: `https://${crypto.randomUUID()}.invalid` },
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
  const pending = queue.enter('a', 'Slow', definition.competition);
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    const fast = await queue.enter('a', 'Fast', definition.competition);
    if (!fast.ok) throw new Error(fast.code);
    expect((await queue.cancel('a', fast.room)).ok).toBe(true);
  } finally {
    released = true;
  }
  expect(await pending).toEqual({ ok: false, code: 'STALE_REQUEST' });
  expect(await queue.enter('a', '', definition.competition, true)).toEqual({
    ok: false,
    code: 'NO_ACTIVE_MATCH',
  });
});

it('組織内A/Bの同時参加は一つ、他のactorの待機列はインスタンス別', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const a = { id: crypto.randomUUID(), owner };
  const b = { id: crypto.randomUUID(), owner };
  const results = await Promise.all([
    queue.enter('same', 'S', definition.competition, false, a),
    queue.enter('same', 'S', definition.competition, false, b),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  const first = await queue.enter('first', 'A', definition.competition, false, a);
  const second = await queue.enter('second', 'B', definition.competition, false, b);
  if (!first.ok || !second.ok) throw new Error('join');
  expect(first.room).not.toBe(second.room);
  expect(await queue.enter('first', '', undefined, true, b)).toMatchObject({
    ok: false,
    code: 'OTHER_INSTANCE_ACTIVE',
    instanceId: a.id,
  });
  expect(await queue.cancel('first', first.room, false, b.id)).toMatchObject({
    ok: false,
  });
  await evictDurableObject(queue);
  expect(await queue.enter('first', '', undefined, true, a)).toEqual(first);
});

it('取消済みの世代は、部屋が未作成でも遅延した予約を再成立させない', async () => {
  const room = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner };
  expect(await room.cancelReservation('a', false, 'old-generation')).toBe(true);
  await evictDurableObject(room);
  expect(
    await room.reserve('a', 'A', 'old-token', definition, scope, 'old-generation'),
  ).toEqual({ ok: false, code: 'STALE_RESERVATION' });
  expect(
    (await room.reserve('a', 'A', 'new-token', definition, scope, 'new-generation')).ok,
  ).toBe(true);
  expect(await room.cancelReservation('a', false, 'old-generation')).toBe(false);
  expect((await room.lobbyStatus())?.actors).toEqual(['a']);
});

it('部屋トークンは別インスタンスIDのWebSocketに使えない', async () => {
  const room = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner };
  await room.reserve('a', 'A', 'token', definition, scope, 'generation');
  expect(
    (
      await room.reserve(
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
  const a = { id: crypto.randomUUID(), owner };
  const b = { id: crypto.randomUUID(), owner };
  const first = await queue.enter('a', 'A', definition.competition, false, a);
  if (!first.ok) throw new Error(first.code);
  const room = runtime.GAME_ROOM.getByName(`1c:${first.room}`);
  await runInDurableObject(room, async (_instance, ctx) => {
    const saved = await ctx.storage.get<{ state: State; resultRetryAt?: number }>('room');
    if (!saved) throw new Error('room');
    saved.state.phase = 'FINISHED';
    saved.state.deadline = null;
    saved.resultRetryAt = Date.now() + 60000;
    await ctx.storage.put('room', saved);
  });
  expect((await queue.enter('a', 'A', definition.competition, false, b)).ok).toBe(true);
  expect((await state(room))?.phase).toBe('FINISHED');
});

it('候補0の検出で待機を解除し、候補復旧後は本人の再参加だけを受け付ける', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner };
  const first = await queue.enter('a', 'A', definition.competition, false, scope);
  if (!first.ok) throw new Error(first.code);
  mocks.load.mockRejectedValueOnce(new Error('NO_RANKED_QUESTIONS'));
  await runDurableObjectAlarm(queue);
  expect(
    (await runtime.GAME_ROOM.getByName(`1c:${first.room}`).lobbyStatus())?.closed,
  ).toBe(true);
  expect(await queue.enter('a', '', undefined, true, scope)).toEqual({
    ok: false,
    code: 'NO_ACTIVE_MATCH',
  });
  const next = await queue.enter('a', 'A', definition.competition, false, scope);
  expect(next.ok).toBe(true);
  if (next.ok) expect(next.room).not.toBe(first.room);
});

it('候補0の待機解除は開始済みの固定問題や終端を変更しない', async () => {
  const room = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner };
  await room.reserve('a', 'A', 'token', definition, scope, 'generation');
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
  const a = { id: crypto.randomUUID(), owner };
  const b = { id: crypto.randomUUID(), owner };
  const first = await queue.enter('a', 'A', definition.competition, false, a);
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
    expect(await queue.enter('a', 'A', definition.competition, false, b)).toMatchObject({
      ok: false,
      code: 'OTHER_INSTANCE_ACTIVE',
    });
  } finally {
    restore();
  }
  expect(await queue.enter('a', '', undefined, true, a)).toEqual(first);
});

it('レビューR01: logout応答消失中の復帰でも進行中の組織参加枠を保持する', async () => {
  definition.playersPerMatch = 2;
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const scope = { id: crypto.randomUUID(), owner };
  const other = { id: crypto.randomUUID(), owner };
  const first = await queue.enter('a', 'A', definition.competition, false, scope);
  const second = await queue.enter('b', 'B', definition.competition, false, scope);
  if (!first.ok || !second.ok) throw new Error('setup');
  const room = runtime.GAME_ROOM.getByName(`1c:${first.room}`);
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
    const resumed = await queue.enter('a', '', definition.competition, true, scope);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.token).not.toBe(first.token);
    expect(
      await queue.enter('a', 'A', definition.competition, false, other),
    ).toMatchObject({ ok: false, code: 'OTHER_INSTANCE_ACTIVE' });
    expect((await state(room))?.phase).toBe('REVEALING');
    expect((await state(room))?.players.map((p) => p.id)).toContain('a');
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
    const first = await queue.enter('a', 'A', definition.competition);
    if (!first.ok) throw new Error(first.code);
    const room = runtime.GAME_ROOM.getByName(`1c:${first.room}`);
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
    expect(await queue.enter('a', '', definition.competition, true)).toMatchObject({
      ok: false,
      code: 'NO_ACTIVE_MATCH',
    });
    await evictDurableObject(queue);
    expect(
      kind === 'room'
        ? await queue.cancel('a', first.room, true)
        : await queue.logoutActor('a'),
    ).toEqual({ ok: true });
    expect(
      (
        await room.fetch('https://game.test', {
          headers: { Upgrade: 'websocket', 'X-Game-Session': first.token },
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
          created: 0,
          scope,
        },
      ]),
    );
    await ctx.storage.put('queue', { actors, rates: {} });
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
    expect(
      (await queue.enter('new', 'New', definition.competition, false, scope)).ok,
    ).toBe(true);
    expect(
      await runInDurableObject(queue, async (_instance, ctx) => ctx.storage.getAlarm()),
    ).toBe(before);
  } finally {
    restore();
  }
});

it('レビューR10: 故障した部屋を保持して、正常な別室への参加は受け付ける', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = await queue.enter('a', 'A', definition.competition);
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
    const joined = await queue.enter('b', 'B', definition.competition);
    expect(joined.ok).toBe(true);
    if (joined.ok) expect(joined.room).not.toBe(first.room);
    expect(await queue.enter('a', 'A', definition.competition)).toMatchObject({
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
      expect(await instance.enter('a', 'A', definition.competition)).toMatchObject({
        ok: false,
        code: 'LOGOUT_PENDING',
      });
      releases[1]();
      await second;
      expect((await instance.enter('a', 'A', definition.competition)).ok).toBe(true);
    } finally {
      for (const release of releases) release();
      await Promise.allSettled([first, second]);
      restore();
    }
  });
});

it('DEV01: failed logout remains blocked across eviction and a retry revokes the old token', async () => {
  const queue = runtime.MATCHMAKER.getByName(crypto.randomUUID());
  const first = await queue.enter('a', 'A', definition.competition);
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
  expect(await queue.enter('a', 'A', definition.competition)).toMatchObject({
    ok: false,
    code: 'LOGOUT_PENDING',
  });
  expect(await queue.logoutActor('a')).toEqual({ ok: true });
  const room = runtime.GAME_ROOM.getByName(`1c:${first.room}`);
  expect(
    (
      await room.fetch('https://game.test', {
        headers: { Upgrade: 'websocket', 'X-Game-Session': first.token },
      })
    ).status,
  ).toBe(401);
  expect((await queue.enter('a', 'A', definition.competition)).ok).toBe(true);
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
  const result = await queue.enter('a', 'A', definition.competition);
  expect(result.ok).toBe(true);
  const queueBytes = await runInDurableObject(
    queue,
    async (_instance, ctx) =>
      new TextEncoder().encode(JSON.stringify(await ctx.storage.get('queue'))).length,
  );
  expect(queueBytes).toBeLessThan(4096);
  await evictDurableObject(queue);
  expect(await queue.enter('a', '', definition.competition, true)).toEqual(result);
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
      actors: {},
      rates: Object.fromEntries(
        Array.from({ length: 1024 }, (_, i) => [
          `actor-${i}`,
          { at: Date.now(), count: 1 },
        ]),
      ),
    });
  });
  expect(await queue.enter('overflow', 'New', definition.competition)).toEqual({
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
  expect((await queue.enter('overflow', 'New', definition.competition)).ok).toBe(true);
});
