import {
  applyD1Migrations,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Command } from '../src/shared/game';
import { newRoomSettings } from '../src/shared/rooms';
import type { MatchDefinition } from '../src/worker/catalog/definition';
import { contentHash } from '../src/worker/catalog/hash';
import { changeD1, connectD1 } from '../src/worker/db/d1';
import { instanceRooms, roomMembers } from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { dummyCharacters } from '../src/worker/game/questions';
import { rules } from '../src/worker/game/rules';
import { advance, type State } from '../src/worker/game/state';
import { readStored, writeStored } from '../src/worker/game/storage';
import { setupOrganization } from '../src/worker/organization/database';
import { startMatch } from '../src/worker/results/lifecycle';
import { makeResultRecord } from '../src/worker/results/record';
import { RoomLobby, type UserRoom } from '../src/worker/rooms/RoomLobby';
import { roomResult } from '../src/worker/rooms/rpc';
import { joinRoom, roomViews } from '../src/worker/rooms/store';
import { questionProvenance, questions } from './fixtures/questions';

const mocks = vi.hoisted(() => ({
  definition: vi.fn(),
  allowed: vi.fn(),
  register: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../src/worker/results/lifecycle', async (original) => ({
  ...(await original<typeof import('../src/worker/results/lifecycle')>()),
  registerMatch: vi.fn(async (_env, _scope, record) => record),
  startMatch: vi.fn(),
  cancelMatch: vi.fn(),
}));
vi.mock('../src/worker/organization/database', async (original) => ({
  ...(await original<typeof import('../src/worker/organization/database')>()),
  allowedInstanceActors: mocks.allowed,
}));
vi.mock('../src/worker/rooms/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/worker/rooms/database')>()),
  roomDefinition: mocks.definition,
}));
vi.mock('../src/worker/results/database', () => ({
  saveResult: mocks.save,
  ResultConflict: class extends Error {},
}));
const runtime = env as unknown as Env;
let definition: MatchDefinition;
const scope = {
  id: String(crypto.randomUUID()),
  owner: 'https://room.test',
  mode: 'room' as const,
};
const actor = (i: number, guest = false) => ({
  id: `room-actor-${i}`,
  name: `参加者${i}`,
  serverName: '所属元',
  guest,
});
const db = connectD1(runtime.GAME_D1 as D1Database);
beforeAll(async () => {
  await applyD1Migrations(
    runtime.GAME_D1 as D1Database,
    (env as unknown as { D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .D1_MIGRATIONS,
  );
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: 'ロビー',
    instanceName: 'ロビー',
  });
  const [instance] = await db
    .select()
    .from((await import('../src/worker/db/schema')).instances);
  scope.id = instance.id;
  scope.owner = instance.owner;
});
type Stub = DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>;
beforeEach(async () => {
  mocks.register.mockReset();
  mocks.allowed.mockReset();
  mocks.definition.mockReset();
  mocks.save.mockReset();
  mocks.allowed.mockImplementation(async (_env, _scope, ids: string[]) => ids);
  const fixed = {
    ...rules,
    showSelections: true,
    winMode: 'target' as const,
    questionLimit: 7,
    noDisqualification: false,
  };
  const manifest = questions.map((question) => ({
    ...question,
    ...questionProvenance,
    version: 1,
    distractors: [...dummyCharacters],
  }));
  const ref = { owner: scope.owner, id: 'fixture', version: 1 };
  definition = {
    kind: 'room',
    original: false,
    competition: ref,
    ruleset: ref,
    questionSet: ref,
    rulesHash: await contentHash(fixed),
    manifestHash: await contentHash(manifest),
    playersPerMatch: 2,
    rules: fixed,
    questions: manifest,
  };
  mocks.definition.mockImplementation(async () => structuredClone(definition));
});
async function read(stub: Stub) {
  return runInDurableObject(stub, async (_instance, ctx) =>
    new RoomLobby(ctx, runtime).read(),
  );
}
async function childState(stub: Stub) {
  return runInDurableObject(
    stub,
    async (_instance, ctx) =>
      (await readStored<{ state: State }>(ctx.storage, 'room'))?.state,
  );
}
async function socket(stub: Stub, token: string, parent = true) {
  const response = await stub.fetch('https://room.test', {
    headers: {
      Upgrade: 'websocket',
      'X-Game-Session': token,
      'X-Game-Instance': scope.id,
    },
  });
  if (!response.webSocket) throw new Error(`upgrade:${response.status}:${parent}`);
  response.webSocket.accept();
  return response.webSocket;
}
async function lobby(count = 2, presenter = false) {
  const id = crypto.randomUUID(),
    stub = runtime.GAME_ROOM.getByName(`room:${id}`),
    sockets: WebSocket[] = [];
  const settings = {
    ...newRoomSettings(true),
    name: '検証部屋',
    capacity: count,
    presenter,
  };
  await stub.createUserRoom(id, scope, actor(0), {
    settings,
    operationId: crypto.randomUUID(),
  });
  for (let i = 0; i < count + (presenter ? 1 : 0); i++) {
    expect(
      (await stub.joinUserRoom(actor(i), `token-${i}`, `generation-${i}`, '', '', scope))
        .ok,
    ).toBe(true);
    sockets.push(await socket(stub, `token-${i}`));
  }
  for (let i = presenter ? 1 : 0; i < count + (presenter ? 1 : 0); i++)
    await stub.mutateUserRoom(actor(i), {
      action: 'ready',
      ready: true,
      operationId: crypto.randomUUID(),
    });
  return {
    id,
    stub,
    sockets,
    close: () =>
      sockets.forEach((socket) => {
        try {
          socket.close();
        } catch {}
      }),
  };
}
async function start(stub: Stub) {
  const room = await read(stub);
  return stub.mutateUserRoom(actor(0), {
    action: 'start',
    revision: room?.revision,
    operationId: crypto.randomUUID(),
  });
}

it('ロビーと試合の診断は状態を変えず1回だけ記録し、休止後も受信済みを保持する', async () => {
  const room = await lobby(2);
  const games: WebSocket[] = [];
  const logs: string[] = [];
  const logged = vi
    .spyOn(console, 'info')
    .mockImplementation((line) => logs.push(String(line)));
  try {
    expect(await start(room.stub)).toMatchObject({ ok: true });
    const parent = await read(room.stub);
    if (!parent?.match) throw new Error('MATCH_REQUIRED');
    const child = runtime.GAME_ROOM.getByName(`match:${parent.match.id}`);
    for (const participant of [actor(0), actor(1)])
      games.push(await socket(child, parent.match.tokens[participant.id], false));
    for (const stub of [room.stub, child]) {
      await runInDurableObject(stub, async (instance, context) => {
        const socket = context.getWebSockets()[0];
        const before = await context.storage.list();
        const report = JSON.stringify({
          type: 'connection_report',
          connectMs: 3,
          recovery: {
            connectionId: crypto.randomUUID(),
            trigger: 'receive_timeout',
            at: Date.now() - 2000,
            attempts: 1,
            elapsedMs: 2000,
          },
        });
        await instance.webSocketMessage(socket, report);
        await instance.webSocketMessage(socket, report);
        expect(socket.deserializeAttachment().reportReceived).toBe(true);
        expect(socket.deserializeAttachment().clientReport).toEqual(JSON.parse(report));
        expect(await context.storage.list()).toEqual(before);
      });
      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance, context) => {
        const socket = context
          .getWebSockets()
          .find((socket) => socket.deserializeAttachment().reportReceived);
        expect(socket).toBeDefined();
        if (!socket) throw new Error('SOCKET_REQUIRED');
        await instance.webSocketMessage(
          socket,
          JSON.stringify({ type: 'connection_report', connectMs: 3 }),
        );
        await instance.webSocketMessage(socket, 'sync');
        expect(socket.deserializeAttachment().live).toBe(true);
        await instance.webSocketClose(socket, 1000, '', true);
      });
    }
    expect(
      logs
        .map((line) => JSON.parse(line))
        .filter((line) => line.event === 'socket_client_report'),
    ).toHaveLength(2);
    for (const event of ['game_socket_closed', 'room_lobby_closed']) {
      const closed = logs
        .map((line) => JSON.parse(line))
        .find((line) => line.event === event);
      expect(closed).toMatchObject({
        reportReceived: true,
        clientReport: {
          type: 'connection_report',
          connectMs: 3,
          recovery: { trigger: 'receive_timeout', attempts: 1, elapsedMs: 2000 },
        },
      });
    }
  } finally {
    logged.mockRestore();
    for (const socket of games) socket.close();
    room.close();
  }
});

it.each([
  ['tracked', false],
  ['tracked', true],
  ['current', false],
  ['current', true],
  ['prepared', false],
  ['prepared', true],
] as const)(
  '開始保存待ちの失効は予約を保持し、復旧後の再試行で完了する 経路=%s 棄権=%s',
  async (route, forfeit) => {
    vi.mocked(startMatch).mockRejectedValue(new Error('DB_OFFLINE'));
    // Keep two answerers after the forfeit so result cleanup cannot race these assertions.
    const room = await lobby(3);
    const participants = [actor(0), actor(1), actor(2)];
    const games: WebSocket[] = [];
    try {
      expect(await start(room.stub)).toMatchObject({ ok: true });
      const parent = await read(room.stub);
      if (!parent?.match) throw new Error('missing match');
      const match = parent.match;
      const child = runtime.GAME_ROOM.getByName(`match:${match.id}`);
      for (const participant of participants)
        games.push(await socket(child, match.tokens[participant.id], false));
      const sessionKey = `child-session:${actor(1).id}:${match.id}`;
      const operationId = crypto.randomUUID();
      await runInDurableObject(room.stub, async (_, ctx) => {
        if (route !== 'tracked') await ctx.storage.delete(sessionKey);
        if (route === 'prepared') {
          const saved = await ctx.storage.get<UserRoom>('user-room');
          if (!saved) throw new Error('missing parent');
          saved.match = undefined;
          saved.playing = false;
          saved.starting = {
            id: match.id,
            operationId,
            hash: 'prepared-start',
            revision: parent.revision,
          };
          await ctx.storage.put('user-room', saved);
          await writeStored(ctx.storage, `start:${operationId}`, {
            actor: actor(0).id,
            hash: 'prepared-start',
            id: match.id,
            definition: { ...definition, playersPerMatch: participants.length },
            tokens: match.tokens,
            members: participants,
          });
        }
      });
      const cancel = () =>
        room.stub.cancelReservation(
          'room',
          actor(1).id,
          true,
          'generation-1',
          'token-1',
          forfeit,
        );
      expect(await cancel()).toBe(false);
      expect(await cancel()).toBe(false);
      expect(
        (await read(room.stub))?.members.some((member) => member.id === actor(1).id),
      ).toBe(true);
      await runInDurableObject(room.stub, async (_, ctx) => {
        expect(await ctx.storage.get('closed:generation-1')).toBeUndefined();
        if (route === 'tracked') expect(await ctx.storage.get(sessionKey)).toBeDefined();
        if (route === 'prepared')
          expect(await readStored(ctx.storage, `start:${operationId}`)).toBeDefined();
      });

      vi.mocked(startMatch).mockResolvedValue(undefined);
      await runInDurableObject(child, async (_, ctx) => {
        const saved = await ctx.storage.get<{
          starting?: unknown;
          lifecycleRetryAt: number;
        }>('room');
        if (!saved?.starting) throw new Error('missing pending start');
        saved.lifecycleRetryAt = Date.now();
        await ctx.storage.put('room', saved);
      });
      await runDurableObjectAlarm(child);
      expect((await childState(child))?.phase).toBe('REVEALING');
      expect(await cancel()).toBe(true);
      expect(
        (await read(room.stub))?.members.some((member) => member.id === actor(1).id),
      ).toBe(false);
      await runInDurableObject(room.stub, async (_, ctx) => {
        expect(await ctx.storage.get(sessionKey)).toBeUndefined();
      });
      expect(
        (await childState(child))?.players.find((player) => player.id === actor(1).id)
          ?.forfeited === true,
      ).toBe(forfeit);
      const reconnect = await child.fetch('https://room.test', {
        headers: {
          Upgrade: 'websocket',
          'X-Game-Session': match.tokens[actor(1).id],
          'X-Game-Instance': scope.id,
        },
      });
      expect(reconnect.status).toBe(401);
    } finally {
      vi.mocked(startMatch).mockReset();
      for (const game of games) game.close();
      room.close();
    }
  },
);

it.each([
  [false, 'WAITING'],
  [false, 'REVEALING'],
  [true, 'WAITING'],
  [true, 'REVEALING'],
] as const)(
  '取消の読込後に始まった試合の参加者を保持する 前試合=%s 子の状態=%s',
  async (previousMatch, phase) => {
    const room = await lobby();
    try {
      if (previousMatch) {
        expect(await start(room.stub)).toMatchObject({ ok: true });
        const parent = await read(room.stub);
        if (!parent?.match) throw new Error('missing previous match');
        const child = runtime.GAME_ROOM.getByName(`match:${parent.match.id}`);
        await runInDurableObject(child, async (_, ctx) => {
          const saved = await readStored<{ state: State }>(ctx.storage, 'room');
          if (!saved) throw new Error('missing previous child');
          saved.state.phase = 'FINISHED';
          saved.state.startedAt = Date.now() - 1;
          saved.state.result = {
            finishedAt: Date.now(),
            winnerId: actor(0).id,
            reason: 'exhausted',
            storage: 'pending',
          };
          saved.state.completed = makeResultRecord(saved.state, saved.state.result);
          await ctx.storage.put('room', saved);
        });
      }
      await runInDurableObject(room.stub, async (_, ctx) => {
        const stale = new RoomLobby(ctx, runtime);
        const originalRead = stale.read.bind(stale);
        const games: WebSocket[] = [];
        const spy = vi.spyOn(stale, 'read').mockImplementationOnce(async () => {
          const snapshot = await originalRead();
          if (!snapshot) throw new Error('missing room');
          const other = new RoomLobby(ctx, runtime);
          if (snapshot.match) {
            await other.matchFinished(snapshot.match.id);
            for (const participant of [actor(0), actor(1)])
              await other.mutate(participant, {
                action: 'ready',
                ready: true,
                operationId: crypto.randomUUID(),
              });
          }
          expect(
            await other.mutate(actor(0), {
              action: 'start',
              revision: (await other.read())?.revision,
              operationId: crypto.randomUUID(),
            }),
          ).toMatchObject({ ok: true });
          const playing = await other.read();
          if (!playing?.match) throw new Error('missing child');
          const child = runtime.GAME_ROOM.getByName(`match:${playing.match.id}`);
          if (phase === 'REVEALING')
            for (const participant of [actor(0), actor(1)])
              games.push(
                await socket(child, playing.match.tokens[participant.id], false),
              );
          expect((await child.lobbyStatus())?.phase).toBe(phase);
          return snapshot;
        });
        try {
          expect(await stale.cancel(actor(1).id, false, 'generation-1', 'token-1')).toBe(
            false,
          );
          expect(
            (await new RoomLobby(ctx, runtime).read())?.members.find(
              (member) => member.id === actor(1).id,
            ),
          ).toMatchObject({ generation: 'generation-1', token: 'token-1' });
          expect(await ctx.storage.get('closed:generation-1')).toBeUndefined();
          expect(
            ctx.getWebSockets().some((connection) => {
              const attachment = connection.deserializeAttachment() as {
                actorId: string;
                live: boolean;
              };
              return attachment.actorId === actor(1).id && attachment.live;
            }),
          ).toBe(true);
        } finally {
          spy.mockRestore();
          for (const game of games) game.close();
        }
      });
    } finally {
      room.close();
    }
  },
);

it.each([
  ['both', false],
  ['both', true],
  ['generation', false],
  ['generation', true],
  ['token', false],
  ['token', true],
] as const)(
  '遅延した旧予約の取消は再入室後の接続と子セッションを保護する 変更=%s 失効=%s',
  async (changed, revoke) => {
    const room = await lobby();
    const nextToken = changed === 'generation' ? 'token-0' : 'new-token';
    const nextGeneration = changed === 'token' ? 'generation-0' : 'new-generation';
    const previousChild = crypto.randomUUID();
    const nextChild = crypto.randomUUID();
    try {
      await runInDurableObject(room.stub, async (_, ctx) => {
        const stale = new RoomLobby(ctx, runtime);
        const read = stale.read.bind(stale);
        let fresh: WebSocket | undefined;
        const spy = vi.spyOn(stale, 'read').mockImplementationOnce(async () => {
          const snapshot = await read();
          const other = new RoomLobby(ctx, runtime);
          expect(await other.cancel(actor(0).id, false, 'generation-0', 'token-0')).toBe(
            true,
          );
          // Matchmaker persists a new admission in D1 before the lobby sees it.
          expect(
            await joinRoom(
              runtime,
              room.id,
              actor(0),
              nextToken,
              nextGeneration,
              '',
              '',
              scope,
            ),
          ).toMatchObject({ ok: true });
          const response = await other.fetch(
            new Request('https://room.test', {
              headers: {
                Upgrade: 'websocket',
                'X-Game-Session': nextToken,
                'X-Game-Instance': scope.id,
              },
            }),
          );
          fresh = response.webSocket ?? undefined;
          if (!fresh) throw new Error(`upgrade:${response.status}`);
          fresh.accept();
          for (const [id, generation, parentToken, token] of [
            [previousChild, 'generation-0', 'token-0', 'old-child-token'],
            [nextChild, nextGeneration, nextToken, 'new-child-token'],
          ])
            await ctx.storage.put(`child-session:${actor(0).id}:${id}`, {
              actor: actor(0).id,
              room: id,
              token,
              parentToken,
              generation,
              expires: Date.now() + 60000,
            });
          return snapshot;
        });
        try {
          expect(await stale.cancel(actor(0).id, revoke, 'generation-0', 'token-0')).toBe(
            false,
          );
          const live = ctx.getWebSockets().filter((socket) => {
            const attachment = socket.deserializeAttachment() as {
              actorId: string;
              live: boolean;
            };
            return attachment.actorId === actor(0).id && attachment.live;
          });
          expect(live).toHaveLength(1);
          expect(
            (await new RoomLobby(ctx, runtime).read())?.members.find(
              (member) => member.id === actor(0).id,
            ),
          ).toMatchObject({ generation: nextGeneration, token: nextToken });
          expect(
            await ctx.storage.get(`child-session:${actor(0).id}:${nextChild}`),
          ).toBeDefined();
          expect(
            !!(await ctx.storage.get(`child-session:${actor(0).id}:${previousChild}`)),
          ).toBe(!revoke);
        } finally {
          spy.mockRestore();
          fresh?.close();
        }
      });
      for (const [id, token, revoked] of [
        [previousChild, 'old-child-token', revoke],
        [nextChild, 'new-child-token', false],
      ] as const)
        await runInDurableObject(
          runtime.GAME_ROOM.getByName(`match:${id}`),
          async (_, ctx) => {
            expect(!!(await ctx.storage.get(`revoked:${token}`))).toBe(revoked);
          },
        );
    } finally {
      room.close();
    }
  },
);

it('ロビーの不正な診断用接続IDは既存接続を切断せず400で拒否する', async () => {
  const room = await lobby();
  try {
    const response = await room.stub.fetch('https://room.test?connection=invalid', {
      headers: {
        Upgrade: 'websocket',
        'X-Game-Session': 'token-1',
        'X-Game-Instance': scope.id,
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'INVALID_CONNECTION_ID' });
    const synced = new Promise((resolve, reject) => {
      room.sockets[0].addEventListener('message', resolve, { once: true });
      room.sockets[0].addEventListener('close', () => reject(new Error('DISCONNECTED')), {
        once: true,
      });
    });
    room.sockets[0].send('sync');
    await synced;
  } finally {
    room.close();
  }
});

it('開始準備中のalarmは生きている予約を保持し、期限切れだけ回収する', async () => {
  const room = await lobby();
  try {
    const childId = crypto.randomUUID();
    await runInDurableObject(room.stub, async (_instance, ctx) => {
      const saved = await readStored<UserRoom>(ctx.storage, 'user-room');
      if (!saved) throw new Error('room');
      saved.starting = {
        operationId: crypto.randomUUID(),
        hash: 'pending',
        revision: (await new RoomLobby(ctx, runtime).read())?.revision ?? 0,
        id: childId,
        expires: Date.now() + 60000,
      };
      await ctx.storage.transaction((tx) => writeStored(tx, 'user-room', saved));
      await ctx.storage.setAlarm(Date.now() + 1);
    });
    await runDurableObjectAlarm(room.stub);
    expect((await read(room.stub))?.starting?.id).toBe(childId);
    await runInDurableObject(room.stub, async (_instance, ctx) => {
      const saved = await readStored<UserRoom>(ctx.storage, 'user-room');
      if (!saved?.starting) throw new Error('start');
      saved.starting.expires = Date.now() - 1;
      await ctx.storage.transaction((tx) => writeStored(tx, 'user-room', saved));
      await ctx.storage.setAlarm(Date.now() + 1);
    });
    await runDurableObjectAlarm(room.stub);
    expect((await read(room.stub))?.starting).toBeUndefined();
    expect(await start(room.stub)).toMatchObject({ ok: true });
  } finally {
    room.close();
  }
});

it('8回答者＋専任。準備完了・部屋主開始、未出題内容はロビーへ送らない', async () => {
  const room = await lobby(8, true),
    games: WebSocket[] = [];
  try {
    const view = roomResult(await room.stub.userRoomView(actor(1).id));
    expect(view.settings.capacity).toBe(8);
    expect(view.members).toHaveLength(9);
    expect(view.members.every((member) => member.serverName === '所属元')).toBe(true);
    expect(JSON.stringify(view)).not.toContain(definition.questions[0].text);
    expect(
      await room.stub.mutateUserRoom(actor(1), {
        action: 'start',
        revision: view.revision,
        operationId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: false, code: 'ROOM_HOST_REQUIRED' });
    await start(room.stub);
    const fixed = await read(room.stub);
    if (!fixed?.match) throw new Error('match');
    const game = runtime.GAME_ROOM.getByName(`match:${fixed.match.id}`);
    for (let i = 1; i <= 8; i++)
      games.push(await socket(game, fixed.match.tokens[actor(i).id], false));
    expect((await childState(game))?.phase).toBe('REVEALING');
    expect(
      (await childState(game))?.players.filter((player) => player.role === 'presenter'),
    ).toHaveLength(1);
    const current = await childState(game);
    if (!current) throw new Error('state');
    expect(current.players.every((player) => player.serverName === '所属元')).toBe(true);
    const commands: Command[] = games.map(() => ({
      commandId: crypto.randomUUID(),
      matchId: current.matchId,
      questionId: current.question.id,
      type: 'buzz' as const,
      payload: {},
    }));
    const ack = (socket: WebSocket, command: (typeof commands)[number]) =>
      new Promise<import('../src/shared/game').Reply>((resolve) => {
        const listen = (event: MessageEvent) => {
          const message = JSON.parse(event.data as string);
          if (message.type === 'ack' && message.reply.commandId === command.commandId) {
            socket.removeEventListener('message', listen);
            resolve(message.reply);
          }
        };
        socket.addEventListener('message', listen);
        socket.send(JSON.stringify(command));
      });
    const replies = await Promise.all(games.map((socket, i) => ack(socket, commands[i])));
    expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
    const first = replies.findIndex((reply) => reply.ok);
    expect(
      await runInDurableObject(
        game,
        async (_instance, ctx) => (await ctx.storage.list({ prefix: 'command:' })).size,
      ),
    ).toBe(8);
    await runInDurableObject(game, async (_instance, ctx) => {
      const stored = await readStored<{ state: State }>(ctx.storage, 'room');
      if (!stored) throw new Error('state');
      stored.state.phase = 'JUDGED';
      stored.state.judgment = { actorId: actor(first + 1).id, result: 'correct' };
      stored.state.deadline = Date.now() - 1;
      const presenter = stored.state.players.find(
        (player) => player.role === 'presenter',
      );
      if (presenter) presenter.connected = false;
      advance(stored.state, Date.now());
      await ctx.storage.transaction((tx) => writeStored(tx, 'room', stored));
    });
    expect(await ack(games[first], commands[first])).toEqual(replies[first]);
    expect(await ack(games[first], { ...commands[first], type: 'next' })).toMatchObject({
      ok: false,
      code: 'COMMAND_CONFLICT',
    });
    expect(
      (await room.stub.joinUserRoom(actor(99), 'extra', 'extra', '', '', scope)).ok,
    ).toBe(false);
    expect(
      await runInDurableObject(
        room.stub,
        async (_instance, ctx) => (await ctx.storage.list({ prefix: 'start:' })).size,
      ),
    ).toBe(0);
  } finally {
    games.forEach((socket) => {
      socket.close();
    });
    room.close();
  }
}, 20000);
it('開始再送は同じ試合。保存完了通知後に子を削除して次の試合へ進む', async () => {
  mocks.save.mockRejectedValue(new Error('DB_OFFLINE'));
  const room = await lobby(2);
  try {
    const request = {
      action: 'start',
      revision: (await read(room.stub))?.revision,
      operationId: crypto.randomUUID(),
    };
    const first = await room.stub.mutateUserRoom(actor(0), request);
    expect(await room.stub.mutateUserRoom(actor(0), request)).toEqual(first);
    const parent = await read(room.stub);
    if (!parent?.match) throw new Error('match');
    const child = runtime.GAME_ROOM.getByName(`match:${parent.match.id}`);
    await runInDurableObject(child, async (_instance, ctx) => {
      const saved = await ctx.storage.get<{ state: State }>('room');
      if (!saved) throw new Error('room');
      saved.state.phase = 'FINISHED';
      saved.state.startedAt = Date.now() - 1;
      saved.state.result = {
        finishedAt: Date.now(),
        winnerId: actor(0).id,
        reason: 'exhausted',
        storage: 'pending',
      };
      saved.state.completed = makeResultRecord(saved.state, saved.state.result);
      await ctx.storage.put('room', saved);
    });
    const old = await childState(child);
    await evictDurableObject(room.stub);
    await room.stub.lobbyStatus();
    expect((await read(room.stub))?.match?.id).toBe(parent.match.id);
    expect((await childState(child))?.completed).toEqual(old?.completed);
    mocks.save.mockResolvedValue(undefined);
    await runDurableObjectAlarm(child);
    expect(await childState(child)).toBeUndefined();
    expect((await read(room.stub))?.playing).toBe(false);
    for (let i = 0; i < 2; i++)
      await room.stub.mutateUserRoom(actor(i), {
        action: 'ready',
        ready: true,
        operationId: crypto.randomUUID(),
      });
    await start(room.stub);
    expect((await read(room.stub))?.match?.id).not.toBe(parent.match.id);
    expect(await childState(child)).toBeUndefined();
  } finally {
    room.close();
  }
});
it('子の初期化前に失効したsessionを復活させず、開始を閉じる', async () => {
  const id = crypto.randomUUID();
  const child = runtime.GAME_ROOM.getByName(`match:${id}`);
  const tokens = { [actor(0).id]: 'fixed-0', [actor(1).id]: 'fixed-1' };
  await child.cancelReservation(
    'match',
    actor(0).id,
    true,
    undefined,
    tokens[actor(0).id],
  );
  await evictDurableObject(child);
  await runInDurableObject(child, async (instance, ctx) => {
    await instance.initializeRoomMatch(
      id,
      definition,
      scope,
      [actor(0), actor(1)],
      tokens,
    );
    const saved = await readStored<{
      state: State;
      sessions: Record<string, string>;
      lobby: { closed: boolean };
    }>(ctx.storage, 'room');
    expect(saved?.state.players.some((player) => player.id === actor(0).id)).toBe(false);
    expect(saved?.sessions[tokens[actor(0).id]]).toBeUndefined();
    expect(saved?.lobby.closed).toBe(true);
  });
});

it('開始の応答不明をalarmで回復し、作成後に失効した子sessionを復活させない', async () => {
  const room = await lobby(2);
  try {
    const id = crypto.randomUUID(),
      operationId = crypto.randomUUID();
    const tokens = { [actor(0).id]: 'fixed-0', [actor(1).id]: 'fixed-1' };
    const child = runtime.GAME_ROOM.getByName(`match:${id}`);
    await runInDurableObject(room.stub, async (_instance, ctx) => {
      const stored = await ctx.storage.get<UserRoom>('user-room');
      if (!stored) throw new Error('room');
      stored.starting = {
        operationId,
        id,
        revision: (await new RoomLobby(ctx, runtime).read())?.revision ?? 0,
        hash: 'fixed-hash',
      };
      await ctx.storage.put({
        'user-room': stored,
        [`start:${operationId}`]: {
          actor: actor(0).id,
          hash: 'fixed-hash',
          id,
          definition,
          tokens,
          members: [actor(0), actor(1)],
        },
      });
      await expect(new RoomLobby(ctx, runtime).matchFinished(id)).rejects.toThrow(
        'START_PENDING',
      );
      expect((await new RoomLobby(ctx, runtime).read())?.starting?.id).toBe(id);
    });
    await runDurableObjectAlarm(room.stub);
    expect((await read(room.stub))?.starting).toBeUndefined();
    expect(await childState(child)).toBeDefined();
    await child.cancelReservation(
      'match',
      actor(0).id,
      true,
      undefined,
      tokens[actor(0).id],
    );
    expect(
      (await childState(child))?.players.some((player) => player.id === actor(0).id),
    ).toBe(false);
    expect(
      await child.initializeRoomMatch(
        id,
        definition,
        scope,
        [actor(0), actor(1)],
        tokens,
        room.id,
      ),
    ).toEqual({ ok: true });
    expect(
      (await childState(child))?.players.some((player) => player.id === actor(0).id),
    ).toBe(false);
    expect(
      await runInDurableObject(
        room.stub,
        async (_instance, ctx) => (await ctx.storage.list({ prefix: 'start:' })).size,
      ),
    ).toBe(0);
  } finally {
    room.close();
  }
});
it('開始後に子へ接続できなくても予約失効後に同じロビーで再開できる', async () => {
  const room = await lobby(2);
  try {
    await start(room.stub);
    const parent = await read(room.stub);
    if (!parent?.match) throw new Error('match');
    const child = runtime.GAME_ROOM.getByName(`match:${parent.match.id}`);
    await runInDurableObject(child, async (_instance, ctx) => {
      const saved = await ctx.storage.get<{
        lobby: { reservations: Record<string, number> };
      }>('room');
      if (!saved) throw new Error('room');
      for (const id of Object.keys(saved.lobby.reservations))
        saved.lobby.reservations[id] = Date.now() - 1;
      await ctx.storage.put('room', saved);
    });
    await runDurableObjectAlarm(child);
    await room.stub.lobbyStatus();
    expect((await read(room.stub))?.playing).toBe(false);
    expect((await read(room.stub))?.match).toBeUndefined();
    for (let i = 0; i < 2; i++)
      await room.stub.mutateUserRoom(actor(i), {
        action: 'ready',
        ready: true,
        operationId: crypto.randomUUID(),
      });
    await start(room.stub);
    expect((await read(room.stub))?.playing).toBe(true);
  } finally {
    room.close();
  }
});
it('DB待ち中の退室を開始参加者へ混ぜず、旧generationでは復帰できない', async () => {
  const room = await lobby(3);
  mocks.definition.mockImplementationOnce(async () => {
    const same = runtime.GAME_ROOM.getByName(`room:${room.id}`);
    expect(
      await same.cancelReservation('room', actor(2).id, false, 'generation-2', 'token-2'),
    ).toBe(true);
    return structuredClone(definition);
  });
  try {
    expect(await start(room.stub)).toMatchObject({ ok: false, code: 'EDIT_CONFLICT' });
    expect((await read(room.stub))?.match).toBeUndefined();
    expect(
      (await room.stub.joinUserRoom(actor(2), 'token-2', 'generation-2', '', '', scope))
        .ok,
    ).toBe(false);
    expect((await read(room.stub))?.starting).toBeUndefined();
  } finally {
    room.close();
  }
});
it('部屋主は接続中の入室順へ交代し、復帰で戻さず専任を引き継がない', async () => {
  const room = await lobby(8, true);
  try {
    await runInDurableObject(room.stub, async (instance, ctx) => {
      const host = ctx
        .getWebSockets()
        .find(
          (socket) =>
            (socket.deserializeAttachment() as { actorId: string }).actorId ===
            actor(0).id,
        );
      if (!host) throw new Error('host');
      await instance.webSocketClose(host, 1000, 'test', true);
    });
    expect((await read(room.stub))?.hostId).toBe(actor(1).id);
    expect((await read(room.stub))?.settings.presenter).toBe(false);
    room.sockets.push(await socket(room.stub, 'token-0'));
    expect((await read(room.stub))?.hostId).toBe(actor(1).id);
    const prepare = async () => {
      for (let i = 0; i < 9; i++)
        await room.stub.mutateUserRoom(actor(i), {
          action: 'ready',
          ready: true,
          operationId: crypto.randomUUID(),
        });
    };
    const startByHost = async () =>
      room.stub.mutateUserRoom(actor(1), {
        action: 'start',
        revision: (await read(room.stub))?.revision,
        operationId: crypto.randomUUID(),
      });
    await prepare();
    expect(await startByHost()).toMatchObject({ ok: false, code: 'ROOM_NOT_READY' });
    const current = await read(room.stub);
    if (!current) throw new Error('room');
    expect(
      await room.stub.mutateUserRoom(actor(1), {
        action: 'settings',
        settings: { ...current.settings, presenter: true },
        revision: current.revision,
        operationId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: true });
    await prepare();
    expect(await startByHost()).toMatchObject({ ok: true });
  } finally {
    room.close();
  }
});
it('途中入室はロビー待機、ゲスト禁⽌・公開変更・招待再発行は新入室へ適用', async () => {
  const room = await lobby(3);
  try {
    await room.stub.cancelReservation(
      'room',
      actor(2).id,
      false,
      'generation-2',
      'token-2',
    );
    await start(room.stub);
    expect(
      (await room.stub.joinUserRoom(actor(9, true), 'late', 'late', '', '', scope)).ok,
    ).toBe(true);
    const late = roomResult(await room.stub.userRoomView(actor(9).id));
    expect(late.waiting).toBe(true);
    expect(late.matchRoom).toBeNull();
    const oldInvite = roomResult(await room.stub.userRoomView(actor(0).id)).invite;
    const initial = await read(room.stub);
    if (!initial) throw new Error('room');
    await room.stub.mutateUserRoom(actor(0), {
      action: 'settings',
      settings: { ...initial.settings, public: false, guests: false },
      password: '秘密',
      revision: initial.revision,
      operationId: crypto.randomUUID(),
    });
    await room.stub.mutateUserRoom(actor(0), {
      action: 'invite',
      revision: (await read(room.stub))?.revision,
      operationId: crypto.randomUUID(),
    });
    expect(await room.stub.userRoomInfo(oldInvite)).toMatchObject({
      ok: false,
      code: 'ROOM_NOT_FOUND',
    });
    const invite = roomResult(await room.stub.userRoomView(actor(0).id)).invite ?? '';
    expect(
      (await room.stub.joinUserRoom(actor(10), 'ten', 'ten', 'wrong', invite, scope))
        .code,
    ).toBe('PASSWORD_INCORRECT');
    expect(
      (await room.stub.joinUserRoom(actor(10, true), 'ten', 'ten', '秘密', invite, scope))
        .code,
    ).toBe('PARTICIPATION_RESTRICTED');
    expect(
      (await room.stub.joinUserRoom(actor(9, true), 'late', 'late', '', '', scope)).ok,
    ).toBe(true);
  } finally {
    room.close();
  }
});
it('500問の持込を保存・開始・DO復帰しても内容を維持する', async () => {
  const room = await lobby(2);
  mocks.save.mockRejectedValue(new Error('DB_OFFLINE'));
  try {
    const questions = Array.from({ length: 500 }, () => ({
      text: `${'a'.repeat(149)}😀`,
      displayAnswer: `${'a'.repeat(19)}😀`,
      readings: Array.from('あいうえ').flatMap((first) =>
        Array.from('かき', (second) => `${first}${second}${'あ'.repeat(18)}`),
      ),
      explanation: `${'a'.repeat(299)}😀${'\u0338'.repeat(1430)}`,
    }));
    expect(
      new TextEncoder().encode(JSON.stringify({ version: 1, questions })).length,
    ).toBeLessThan(2000000);
    const initial = await read(room.stub);
    if (!initial) throw new Error('room');
    await changeD1(db, async (writes) => {
      writes.push(
        db
          .update(instanceRooms)
          .set({
            original: questions,
            settings: { ...initial.settings, source: 'original' },
          })
          .where(eq(instanceRooms.roomId, room.id)),
      );
    });
    const manifest = questions.map((question, i) => ({
      ...question,
      id: `original-heavy-${i}`,
      version: 1,
      answer: question.readings[0],
      source: '',
      permission: '部屋用持込',
      demoAllowed: true as const,
      distractors: [...dummyCharacters],
    }));
    definition = {
      ...definition,
      original: true,
      questions: manifest,
      manifestHash: await contentHash(manifest),
    };
    await start(room.stub);
    await evictDurableObject(room.stub);
    expect((await read(room.stub))?.original).toEqual(questions);
    const saved = await read(room.stub);
    if (!saved?.match) throw new Error('match');
    const child = runtime.GAME_ROOM.getByName(`match:${saved.match.id}`);
    await evictDurableObject(child);
    expect((await childState(child))?.questions).toHaveLength(500);
    await runInDurableObject(child, async (_instance, ctx) => {
      const stored = await readStored<{ state: State }>(ctx.storage, 'room');
      if (!stored) throw new Error('room');
      stored.state.completedQuestions = manifest.slice(0, 100).map((question) => ({
        id: question.id,
        text: question.text,
        displayAnswer: question.displayAnswer,
        readings: question.readings,
        explanation: question.explanation,
        source: '',
        correct: false,
        participants: [actor(0).id, actor(1).id],
      }));
      stored.state.phase = 'FINISHED';
      stored.state.startedAt = Date.now() - 1000;
      stored.state.result = {
        finishedAt: Date.now(),
        winnerId: null,
        reason: 'question_limit',
        storage: 'pending',
      };
      stored.state.completed = makeResultRecord(stored.state, stored.state.result);
      await ctx.storage.transaction((tx) => writeStored(tx, 'room', stored));
    });
    await runInDurableObject(child, async (_instance, ctx) => {
      const restored = await readStored<{ scope: typeof scope }>(ctx.storage, 'room');
      expect(restored?.scope.mode).toBe('room');
    });
    const before = (await childState(child))?.completed;
    await evictDurableObject(child);
    await runDurableObjectAlarm(child);
    expect((await childState(child))?.completed).toEqual(before);
    expect((await childState(child))?.result?.storage).toBe('pending');
    expect(
      await runInDurableObject(
        room.stub,
        async (_instance, ctx) =>
          (await ctx.storage.list({ prefix: 'value:start:' })).size,
      ),
    ).toBe(0);
    await runInDurableObject(child, async (_instance, ctx) => {
      const stored = await readStored<{ state: State }>(ctx.storage, 'room');
      if (!stored?.state.result) throw new Error('result');
      stored.state.result.storage = 'confirmed';
      stored.state.result.finishedAt = Date.now() - 31 * 86400000;
      await ctx.storage.transaction((tx) => writeStored(tx, 'room', stored));
    });
    await runDurableObjectAlarm(child);
    expect(await childState(child)).toBeUndefined();
    expect(
      await runInDurableObject(
        child,
        async (_instance, ctx) =>
          (await ctx.storage.list({ prefix: 'value:room:' })).size,
      ),
    ).toBe(0);
  } finally {
    room.close();
  }
}, 30000);
it('期限切れのメンバーは読取から除外し、空室閉鎖で秘密値とDOを消す', async () => {
  const room = await lobby(2);
  try {
    await changeD1(db, async (writes) => {
      writes.push(
        db
          .update(roomMembers)
          .set({ expires: Date.now() - 1 })
          .where(eq(roomMembers.roomId, room.id)),
      );
    });
    expect((await read(room.stub))?.members).toEqual([]);
    expect(
      await db.select().from(roomMembers).where(eq(roomMembers.roomId, room.id)),
    ).toHaveLength(2);
    await runInDurableObject(room.stub, async (instance, ctx) => {
      for (const socket of ctx.getWebSockets())
        await instance.webSocketClose(socket, 1000, 'test', true);
      const saved = await ctx.storage.get<{ emptySince: number }>('user-room');
      if (!saved) throw new Error('room');
      saved.emptySince = Date.now() - 600001;
      await ctx.storage.put('user-room', saved);
      await ctx.storage.setAlarm(Date.now() + 1);
    });
    await runDurableObjectAlarm(room.stub);
    expect(await read(room.stub)).toBeUndefined();
    const [closed] = await db
      .select()
      .from(instanceRooms)
      .where(eq(instanceRooms.roomId, room.id));
    expect(closed).toMatchObject({
      closed: true,
      original: null,
      password: null,
      invite: null,
    });
    expect(
      await db.select().from(roomMembers).where(eq(roomMembers.roomId, room.id)),
    ).toEqual([]);
    await runInDurableObject(room.stub, async (_, ctx) => {
      expect((await ctx.storage.list()).size).toBe(0);
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
  } finally {
    room.close();
  }
});

it('終了通知で全員を親ロビーへ戻し、古い試合の通知は次の試合に影響しない', async () => {
  const room = await lobby();
  try {
    await start(room.stub);
    const first = (await read(room.stub))?.match?.id;
    if (!first) throw new Error('missing match');
    await room.stub.userRoomMatchFinished(first);
    const returned = await read(room.stub);
    expect(returned?.match).toBeUndefined();
    expect(returned?.playing).toBe(false);
    expect(
      Object.values(returned?.members ?? {}).every(
        (member) => member.inLobby && !member.ready,
      ),
    ).toBe(true);
    for (let index = 0; index < 2; index++)
      await room.stub.mutateUserRoom(actor(index), {
        action: 'ready',
        ready: true,
        operationId: crypto.randomUUID(),
      });
    await start(room.stub);
    const second = (await read(room.stub))?.match?.id;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    await room.stub.userRoomMatchFinished(first);
    expect((await read(room.stub))?.match?.id).toBe(second);
  } finally {
    room.close();
  }
});

it('同時入室はD1の定員を超えず、一覧取得でDOを呼ばない', async () => {
  const id = crypto.randomUUID();
  const stub = runtime.GAME_ROOM.getByName(`room:${id}`);
  await stub.createUserRoom(id, scope, actor(0), {
    settings: { ...newRoomSettings(false), name: '同時入室', public: true, capacity: 2 },
    operationId: crypto.randomUUID(),
  });
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      joinRoom(
        runtime,
        id,
        actor(i),
        `parallel-token-${i}`,
        `parallel-generation-${i}`,
        '',
        '',
        scope,
      ),
    ),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(2);
  const getByName = vi.fn(() => {
    throw new Error('DO_MUST_NOT_BE_CALLED');
  });
  const views = await roomViews(
    { ...runtime, GAME_ROOM: { getByName } } as unknown as Env,
    scope.id,
    id,
  );
  expect(views[0].memberCount).toBe(2);
  expect(getByName).not.toHaveBeenCalled();
});

it.each(['WAITING', 'REVEALING'])(
  '失効マーカー保存後の障害を再送で回復する phase=%s',
  async (phase) => {
    const room = await lobby(3);
    const games: WebSocket[] = [];
    try {
      expect(await start(room.stub)).toMatchObject({ ok: true });
      const parent = await read(room.stub);
      if (!parent?.match) throw new Error('missing match');
      const match = parent.match;
      let child = runtime.GAME_ROOM.getByName(`match:${match.id}`);
      if (phase === 'REVEALING')
        for (const participant of [actor(0), actor(1), actor(2)])
          games.push(await socket(child, match.tokens[participant.id], false));
      await expect(
        runInDurableObject(child, async (instance, ctx) => {
          const target = instance as unknown as {
            save(...args: unknown[]): Promise<void>;
          };
          const spy = vi.spyOn(target, 'save').mockImplementationOnce(async () => {
            await ctx.storage.sync();
            throw new Error('STORAGE_SAVE_FAILED');
          });
          try {
            await instance.cancelReservation(
              'match',
              actor(1).id,
              true,
              undefined,
              match.tokens[actor(1).id],
            );
          } finally {
            spy.mockRestore();
          }
        }),
      ).rejects.toThrow('STORAGE_SAVE_FAILED');
      child = runtime.GAME_ROOM.getByName(`match:${match.id}`);
      const beforeRetry = await runInDurableObject(child, async (_, ctx) => {
        const saved = await readStored<{ sessions: Record<string, string> }>(
          ctx.storage,
          'room',
        );
        return {
          revoked: await ctx.storage.get(`revoked:${match.tokens[actor(1).id]}`),
          sessionRetained: saved?.sessions[match.tokens[actor(1).id]] === actor(1).id,
        };
      });
      expect(beforeRetry).toEqual({ revoked: true, sessionRetained: true });
      const accepted = await room.stub.cancelReservation(
        'room',
        actor(1).id,
        true,
        'generation-1',
        'token-1',
      );
      const response = await child.fetch('https://room.test', {
        headers: {
          Upgrade: 'websocket',
          'X-Game-Session': match.tokens[actor(1).id],
          'X-Game-Instance': scope.id,
        },
      });
      if (response.webSocket) {
        response.webSocket.accept();
        games.push(response.webSocket);
      }
      expect(accepted).toBe(true);
      expect(
        (await read(room.stub))?.members.some((member) => member.id === actor(1).id),
      ).toBe(false);
      expect(response.status).toBe(401);
    } finally {
      for (const game of games) game.close();
      room.close();
    }
  },
);
