import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Command } from '../src/shared/game';
import { newRoomSettings } from '../src/shared/rooms';
import type { MatchDefinition } from '../src/worker/catalog/definition';
import { contentHash } from '../src/worker/catalog/hash';
import type { Env } from '../src/worker/env';
import { dummyCharacters } from '../src/worker/game/questions';
import { rules } from '../src/worker/game/rules';
import { advance, type State } from '../src/worker/game/state';
import { readStored, writeStored } from '../src/worker/game/storage';
import { makeResultRecord } from '../src/worker/results/record';
import type { UserRoom } from '../src/worker/rooms/RoomLobby';
import { roomResult } from '../src/worker/rooms/rpc';
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
vi.mock('../src/worker/organization/rooms', () => ({
  registerInstanceRoom: mocks.register,
}));
vi.mock('../src/worker/organization/database', () => ({
  allowedInstanceActors: mocks.allowed,
}));
vi.mock('../src/worker/rooms/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/worker/rooms/database')>()),
  publishRoom: async () => {},
  roomDefinition: mocks.definition,
}));
vi.mock('../src/worker/results/database', () => ({
  saveResult: mocks.save,
  ResultConflict: class extends Error {},
}));
const runtime = env as unknown as Env;
let definition: MatchDefinition;
const scope = {
  id: crypto.randomUUID(),
  owner: 'https://room.test',
  mode: 'room' as const,
};
const actor = (i: number, guest = false) => ({
  id: `room-actor-${i}`,
  name: `参加者${i}`,
  guest,
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
    readStored<UserRoom>(ctx.storage, 'user-room'),
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
        revision: saved.revision,
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
it('未知の開始応答を再送しても子は1試合。再接続・次試合で旧保存待ち原本を維持', async () => {
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
    for (let i = 0; i < 2; i++) {
      await room.stub.mutateUserRoom(actor(i), {
        action: 'return',
        operationId: crypto.randomUUID(),
      });
      await room.stub.mutateUserRoom(actor(i), {
        action: 'ready',
        ready: true,
        operationId: crypto.randomUUID(),
      });
    }
    await start(room.stub);
    expect((await read(room.stub))?.match?.id).not.toBe(parent.match.id);
    expect((await childState(child))?.completed).toEqual(old?.completed);
    expect((await childState(child))?.result?.storage).toBe('pending');
    expect(await child.deletionStatus(scope.id)).toMatchObject({ safe: false });
    const next = await read(room.stub);
    if (!next?.match) throw new Error('next match');
    expect(
      await room.stub.cancelReservation(actor(0).id, true, 'generation-0', 'token-0'),
    ).toBe(true);
    for (const trial of [parent.match, next.match]) {
      const response = await runtime.GAME_ROOM.getByName(`match:${trial.id}`).fetch(
        'https://room.test',
        {
          headers: {
            Upgrade: 'websocket',
            'X-Game-Session': trial.tokens[actor(0).id],
            'X-Game-Instance': scope.id,
          },
        },
      );
      expect(response.status).toBe(401);
    }
    expect((await childState(child))?.completed).toEqual(old?.completed);
  } finally {
    room.close();
  }
});
it('開始の応答不明をalarmで回復し、失効を先に受けた子sessionを復活させない', async () => {
  const room = await lobby(2);
  try {
    const id = crypto.randomUUID(),
      operationId = crypto.randomUUID();
    const tokens = { [actor(0).id]: 'fixed-0', [actor(1).id]: 'fixed-1' };
    const child = runtime.GAME_ROOM.getByName(`match:${id}`);
    await child.cancelReservation(actor(0).id, true, undefined, tokens[actor(0).id]);
    await runInDurableObject(room.stub, async (_instance, ctx) => {
      const stored = await ctx.storage.get<UserRoom>('user-room');
      if (!stored) throw new Error('room');
      stored.starting = {
        operationId,
        id,
        revision: stored.revision,
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
    });
    await runDurableObjectAlarm(room.stub);
    expect((await read(room.stub))?.starting).toBeUndefined();
    expect(await childState(child)).toBeDefined();
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
      await same.cancelReservation(actor(2).id, false, 'generation-2', 'token-2'),
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
  const room = await lobby(2, true);
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
      await instance.webSocketClose(host);
    });
    expect((await read(room.stub))?.hostId).toBe(actor(1).id);
    expect((await read(room.stub))?.settings.presenter).toBe(false);
    room.sockets.push(await socket(room.stub, 'token-0'));
    expect((await read(room.stub))?.hostId).toBe(actor(1).id);
  } finally {
    room.close();
  }
});
it('途中入室はロビー待機、ゲスト禁⽌・公開変更・招待再発行は新入室へ適用', async () => {
  const room = await lobby(3);
  try {
    await room.stub.cancelReservation(actor(2).id, false, 'generation-2', 'token-2');
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
    await runInDurableObject(room.stub, async (_instance, ctx) => {
      const saved = await ctx.storage.get<UserRoom>('user-room');
      if (!saved) throw new Error('room');
      saved.original = questions;
      saved.settings.source = 'original';
      await ctx.storage.transaction((tx) => writeStored(tx, 'user-room', saved));
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
    await child.registerInventory({ id: scope.id, owner: scope.owner });
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
    await child.expireReview();
    expect((await childState(child))?.questions).toEqual([]);
    expect((await childState(child))?.completed?.completedQuestions).toBeUndefined();
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
it('ロビーsession期限と空室10分を消去し、持込・ゲスト名は30日で消去', async () => {
  const room = await lobby(2);
  try {
    await runInDurableObject(room.stub, async (_instance, ctx) => {
      const saved = await ctx.storage.get<UserRoom>('user-room');
      if (!saved) throw new Error('room');
      saved.original = [
        {
          text: '期限検証',
          displayAnswer: '東京',
          readings: ['とうきょう'],
          explanation: '',
        },
      ];
      saved.originalExpires = Date.now() - 1;
      saved.members[1].guest = true;
      saved.members[1].joinedAt = Date.now() - 31 * 86400000;
      saved.members[0].expires = Date.now() - 1;
      await ctx.storage.put('user-room', saved);
    });
    await room.stub.lobbyStatus();
    const stored = await read(room.stub);
    expect(stored?.original).toEqual([]);
    expect(stored?.members.some((member) => member.id === actor(0).id)).toBe(false);
    expect(stored?.members[0].name).toBe('ゲスト');
    await runInDurableObject(room.stub, async (instance, ctx) => {
      for (const socket of ctx.getWebSockets()) await instance.webSocketClose(socket);
      const saved = await ctx.storage.get<UserRoom>('user-room');
      if (!saved) throw new Error('room');
      saved.emptySince = Date.now() - 600001;
      await ctx.storage.put('user-room', saved);
    });
    await runDurableObjectAlarm(room.stub);
    expect((await read(room.stub))?.closed).toBe(true);
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
