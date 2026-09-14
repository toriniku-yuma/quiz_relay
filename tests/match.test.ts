import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { applyGameUpdate } from '../src/client/features/game/recovery';
import type { Command, GameMessage } from '../src/shared/game';
import type { Env } from '../src/worker/env';
import { graphemes } from '../src/worker/game/questions';
import { replayEvents } from '../src/worker/game/recovery';
import {
  adjudicate,
  advance,
  changed,
  createState,
  type State,
  snapshot,
  updateConnections,
} from '../src/worker/game/state';
import { questions } from './fixtures/questions';

function playing(count = 3) {
  const state = createState(questions, 0, count);
  state.players = Array.from({ length: count }, (_, i) => ({
    id: `actor-${i}`,
    name: `Player ${i}`,
    correct: 0,
    mistakes: 0,
    locked: false,
    disqualified: false,
    connected: true,
  }));
  state.phase = 'REVEALING';
  state.deadline = 100000;
  return state;
}

function input(state: State): Command {
  return {
    type: 'buzz',
    commandId: crypto.randomUUID(),
    matchId: state.matchId,
    questionId: state.question.id,
    payload: {},
  };
}

function choose(state: State, correct = true): Command {
  const panel = state.panel;
  if (!panel) throw new Error('No panel');
  const answer = graphemes(state.question.answer)[panel.position];
  const choice = panel.choices.find(({ text }) =>
    correct ? text === answer : text !== answer,
  );
  return {
    ...input(state),
    type: 'choose',
    payload: { attemptId: panel.attemptId, panelId: panel.panelId, choiceId: choice?.id },
  };
}

it('G15: seven correct answers finish at adjudication and later input or disconnect cannot change the result', () => {
  const state = playing(2);
  let now = 100;
  for (let question = 0; question < 7; question++) {
    expect(adjudicate(state, 'actor-0', input(state), now++).ok).toBe(true);
    while (state.panel)
      expect(adjudicate(state, 'actor-0', choose(state), now++).ok).toBe(true);
    if (question < 6) {
      now = state.deadline as number;
      advance(state, now++);
    }
  }

  expect(state.phase).toBe('FINISHED');
  expect(state.result?.winnerId).toBe('actor-0');
  expect(state.players[0].correct).toBe(7);
  const result = structuredClone(state.result);
  expect(adjudicate(state, 'actor-1', input(state), now++).ok).toBe(false);
  updateConnections(state, new Set(), now++);
  expect(state.result).toEqual(result);
  expect(state.phase).toBe('FINISHED');
});

it.each([3, 4])(
  'G05/G16: with %i actors, locks reset and play continues after disqualification',
  (count) => {
    const state = playing(count);
    let now = 100;
    for (let round = 0; round < 3; round++) {
      adjudicate(state, 'actor-0', input(state), now++);
      adjudicate(state, 'actor-0', choose(state, false), now++);
      expect(state.players[0].mistakes).toBe(round + 1);
      expect(state.players[0].locked).toBe(true);
      for (const player of state.players.slice(1)) player.locked = true;
      now = state.deadline as number;
      advance(state, now++);
      expect(state.players[0].locked).toBe(round === 2);
    }

    expect(state.players[0].disqualified).toBe(true);
    expect(state.phase).toBe('REVEALING');
    expect(adjudicate(state, 'actor-0', input(state), now).ok).toBe(false);
    expect(adjudicate(state, 'actor-1', input(state), now).ok).toBe(true);
  },
);

it.each([2, 3, 4])(
  'M06/G16: with %i actors, losing the penultimate eligible actor invalidates immediately',
  (count) => {
    const state = playing(count);
    for (let i = 2; i < count; i++) state.players[i].disqualified = true;
    state.players[0].mistakes = 2;
    adjudicate(state, 'actor-0', input(state), 100);
    const mistake = choose(state, false);
    adjudicate(state, 'actor-0', mistake, 101);

    expect(state.phase).toBe('INVALID');
    expect(state.result?.reason).toBe('disqualifications');
    const result = structuredClone(state.result);
    adjudicate(state, 'actor-0', mistake, 102);
    expect(state.players[0].mistakes).toBe(3);
    expect(state.result).toEqual(result);
  },
);

it('M02/M05: disconnection before the final answer wins the terminal race, WAITING is exempt', () => {
  const state = playing(2);
  state.players[0].correct = 6;
  adjudicate(state, 'actor-0', input(state), 100);
  const answer = choose(state);
  updateConnections(state, new Set(['actor-0']), 101);

  expect(adjudicate(state, 'actor-0', answer, 102).ok).toBe(false);
  expect(state.reconnect?.deadline).toBe(30101);
  updateConnections(state, new Set(['actor-0', 'actor-1']), 30101);
  expect(state.phase).toBe('INVALID');
  expect(state.players[0].correct).toBe(6);

  const waiting = createState(questions, 0, 2);
  updateConnections(waiting, new Set(), 100);
  expect(waiting.phase).toBe('WAITING');
});

it.each([false, true])(
  'G20: exhausted questions resolve unique leader / draw, tie=%s',
  (tie) => {
    const state = playing();
    state.questionIndex = state.questions.length - 1;
    state.question = state.questions[state.questionIndex];
    state.phase = 'JUDGED';
    state.deadline = 100;
    state.judgment = { actorId: null, result: 'unanswered' };
    state.players[0].correct = 4;
    state.players[1].correct = tie ? 4 : 3;
    state.players[2].correct = 6;
    state.players[2].disqualified = true;
    advance(state, 100);

    expect(state.phase).toBe('FINISHED');
    expect(state.result?.reason).toBe('exhausted');
    expect(state.result?.winnerId).toBe(tie ? null : 'actor-0');
  },
);

it('G20: invalidation precedes exhaustion, seventh correct answer precedes exhaustion', () => {
  const state = playing(2);
  state.questionIndex = state.questions.length - 1;
  state.phase = 'JUDGED';
  state.judgment = { actorId: null, result: 'unanswered' };
  state.deadline = 100;
  updateConnections(state, new Set(['actor-0']), 100);
  advance(state, 30100);
  expect(state.result?.reason).toBe('connections');

  const final = playing(2);
  final.questionIndex = final.questions.length - 1;
  final.players[0].correct = 6;
  adjudicate(final, 'actor-0', input(final), 100);
  while (final.panel) adjudicate(final, 'actor-0', choose(final), 101);
  expect(final.result?.reason).toBe('target_reached');
});

it('G06/G08: delta application equals snapshot, gaps and stale history require a snapshot', () => {
  const state = playing();
  changed(state, 100);
  const base = snapshot(state);
  adjudicate(state, 'actor-0', input(state), 101);
  adjudicate(state, 'actor-0', choose(state), 102);
  const events = replayEvents(state.events, state.roomSeq, base.roomSeq, 103);
  expect(events).not.toBeNull();
  const message: Extract<GameMessage, { type: 'delta' }> = {
    type: 'delta',
    matchId: state.matchId,
    fromSeq: base.roomSeq,
    roomSeq: state.roomSeq,
    events: events ?? [],
    panel: null,
    actorId: 'actor-1',
    serverTime: 103,
  };

  expect(applyGameUpdate(base, message)).toEqual(snapshot(state));
  expect(
    applyGameUpdate(base, { ...message, events: message.events.slice(1) }),
  ).toBeNull();
  expect(JSON.stringify(events)).not.toContain('choices');
  expect(JSON.stringify(events)).not.toContain('answer');
  expect(replayEvents(state.events, state.roomSeq, base.roomSeq, 60103)).toBeNull();

  for (let i = 0; i < 600; i++) changed(state, 200 + i);
  expect(state.events).toHaveLength(512);
  expect(replayEvents(state.events, state.roomSeq, 0, 800)).toBeNull();
});

type Stub = DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>;
async function connect(stub: Stub, token: string) {
  const response = await stub.fetch('https://game.test', {
    headers: { Upgrade: 'websocket', 'X-Game-Session': token },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error('No WebSocket');
  socket.accept();
  return socket;
}

async function room(count: number) {
  const stub = (env as unknown as Env).GAME_ROOM.getByName(crypto.randomUUID());
  const tokens: string[] = [];
  const sockets: WebSocket[] = [];
  for (let i = 0; i < count; i++) {
    const joined = await stub.join(
      { name: `P${i}`, questionIndex: 0, players: count },
      undefined,
    );
    if (!joined.ok) throw new Error('Join failed');
    tokens.push(joined.token);
    sockets.push(await connect(stub, joined.token));
  }
  return { stub, tokens, sockets };
}

async function receive(socket: WebSocket, send: string, type: GameMessage['type']) {
  return new Promise<GameMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', listener);
      reject(new Error('Message timeout'));
    }, 3000);
    function listener(event: MessageEvent) {
      const data = JSON.parse(String(event.data)) as GameMessage;
      if (data.type !== type) return;
      clearTimeout(timer);
      socket.removeEventListener('message', listener);
      resolve(data);
    }
    socket.addEventListener('message', listener);
    socket.send(send);
  });
}

async function current(socket: WebSocket) {
  const data = await receive(socket, 'sync', 'state');
  if (data.type !== 'state') throw new Error('Missing state');
  return data;
}

it('DO G06/G07/G10: hibernation and reconnect keep the current panel, deadline, ACK and delta history', async () => {
  const { stub, tokens, sockets } = await room(3);
  try {
    const initial = await current(sockets[0]);
    const buzz: Command = {
      commandId: crypto.randomUUID(),
      matchId: initial.snapshot.matchId,
      questionId: initial.snapshot.questionId,
      type: 'buzz',
      payload: {},
    };
    const ack = await receive(sockets[0], JSON.stringify(buzz), 'ack');
    const firstPanel = (await current(sockets[0])).panel;
    if (!firstPanel) throw new Error('Missing panel');
    const letter = firstPanel.choices.find(({ text }) => text === 'に');
    await receive(
      sockets[0],
      JSON.stringify({
        ...buzz,
        commandId: crypto.randomUUID(),
        type: 'choose',
        payload: {
          attemptId: firstPanel.attemptId,
          panelId: firstPanel.panelId,
          choiceId: letter?.id,
        },
      }),
      'ack',
    );
    const before = await current(sockets[0]);
    expect(before.panel?.position).toBe(1);
    expect(before.panel).not.toBeNull();

    await evictDurableObject(stub);
    const restored = await current(sockets[0]);
    expect(restored.panel).toEqual(before.panel);
    expect(restored.snapshot.response).toEqual({ actorId: before.actorId, text: 'に' });
    expect((await current(sockets[1])).snapshot.response).toEqual(
      restored.snapshot.response,
    );
    expect((await current(sockets[1])).panel).toBeNull();
    expect(restored.snapshot.phase).toBe('ANSWERING');
    expect(await receive(sockets[0], JSON.stringify(buzz), 'ack')).toEqual(ack);

    sockets[0].close();
    await expect
      .poll(
        async () =>
          (await current(sockets[1])).snapshot.players.filter(
            ({ connected }) => connected,
          ).length,
      )
      .toBe(2);
    const replacement = await connect(stub, tokens[0]);
    sockets.push(replacement);
    const delta = await receive(
      replacement,
      JSON.stringify({
        type: 'sync',
        matchId: before.snapshot.matchId,
        lastSeq: before.snapshot.roomSeq,
      }),
      'delta',
    );
    expect(delta.type === 'delta' && delta.panel).toEqual(before.panel);
    expect(delta.type === 'delta' && applyGameUpdate(before.snapshot, delta)?.phase).toBe(
      'ANSWERING',
    );

    const fallback = await receive(
      replacement,
      JSON.stringify({ type: 'sync', matchId: 'wrong', lastSeq: 0 }),
      'state',
    );
    expect(fallback.type === 'state' && fallback.panel).toEqual(before.panel);
  } finally {
    for (const socket of sockets) socket.close();
  }
});

it('DO M02/M04: another tab keeps an actor connected; last tab closing makes a two-player game invalid permanently', async () => {
  const { stub, tokens, sockets } = await room(2);
  const extra = await connect(stub, tokens[0]);
  sockets.push(extra);
  try {
    sockets[0].close();
    await current(extra);
    expect((await current(sockets[1])).snapshot.phase).not.toBe('INVALID');
    extra.close();
    await expect
      .poll(async () => (await current(sockets[1])).snapshot.reconnect)
      .not.toBeNull();
    const paused = (await current(sockets[1])).snapshot.reconnect;
    await evictDurableObject(stub);
    expect((await current(sockets[1])).snapshot.reconnect).toEqual(paused);
    await runInDurableObject(stub, async (_instance, ctx) => {
      const saved = await ctx.storage.get<{ state: State }>('room');
      if (!saved?.state.reconnect) throw new Error('Expected reconnect wait');
      saved.state.reconnect.deadline = Date.now() - 1;
      await ctx.storage.put('room', saved);
      await ctx.storage.setAlarm(Date.now() - 1);
    });
    await runDurableObjectAlarm(stub);
    expect((await current(sockets[1])).snapshot.phase).toBe('INVALID');
    const invalid = (await current(sockets[1])).snapshot.result;

    await evictDurableObject(stub);
    const replacement = await connect(stub, tokens[0]);
    sockets.push(replacement);
    expect((await current(replacement)).snapshot.result).toEqual(invalid);
  } finally {
    for (const socket of sockets) socket.close();
  }
});

it('DO M05: heartbeat expiry removes silent connections before processing the game deadline', async () => {
  const { stub, sockets } = await room(3);
  try {
    await runInDurableObject(stub, async (_instance, ctx) => {
      const peers = ctx.getWebSockets();
      for (const socket of peers.slice(0, 2)) {
        const attachment = socket.deserializeAttachment();
        socket.serializeAttachment({ ...attachment, lastSeen: Date.now() - 15001 });
      }
      await ctx.storage.setAlarm(Date.now() - 1);
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (_instance, ctx) => {
      const saved = await ctx.storage.get<{ state: State }>('room');
      expect(saved?.state.result).toBeNull();
      expect(saved?.state.reconnect?.deadline).toBeGreaterThan(Date.now());
      expect(saved?.state.reconnect?.deadline).toBeLessThanOrEqual(Date.now() + 30000);
      expect(saved?.state.players.filter(({ connected }) => connected)).toHaveLength(1);
    });
  } finally {
    for (const socket of sockets) socket.close();
  }
});

it('G02: replaying a previous question command returns its original ACK without scoring again', () => {
  const state = playing(2);
  const buzz = input(state);
  const ack = adjudicate(state, 'actor-0', buzz, 100);
  while (state.panel) adjudicate(state, 'actor-0', choose(state), 101);
  advance(state, state.deadline as number);

  expect(state.questionIndex).toBe(1);
  expect(adjudicate(state, 'actor-0', buzz, 2200)).toEqual(ack);
  expect(state.players[0].correct).toBe(1);
  expect(
    adjudicate(state, 'actor-0', { ...buzz, questionId: state.question.id }, 2201).code,
  ).toBe('COMMAND_CONFLICT');
});

it('restoration processes only the current overdue transition and all-disqualified state is invalid', () => {
  const state = playing();
  state.deadline = 100;
  advance(state, 1000000);
  expect(state.revealed).toBe(1);
  expect(state.questionIndex).toBe(0);
  expect(state.deadline).toBe(1000100);

  for (const player of state.players) player.disqualified = true;
  advance(state, 1000001);
  expect(state.result?.reason).toBe('disqualifications');
});

it.each([true, false])(
  'selected letters are published only when enabled: %s',
  (enabled) => {
    const state = playing();
    state.rules.showSelections = enabled;
    changed(state, 99);
    const base = snapshot(state);
    adjudicate(state, 'actor-0', input(state), 100);
    const first = choose(state);
    adjudicate(state, 'actor-0', first, 101);
    adjudicate(state, 'actor-0', first, 102);

    expect(state.response).toEqual({ actorId: 'actor-0', text: 'に' });
    expect(snapshot(state).response).toEqual(enabled ? state.response : null);
    const events = replayEvents(state.events, state.roomSeq, base.roomSeq, 103);
    const restored = applyGameUpdate(base, {
      type: 'delta',
      matchId: state.matchId,
      fromSeq: base.roomSeq,
      roomSeq: state.roomSeq,
      events: events ?? [],
      panel: null,
      actorId: 'actor-1',
      serverTime: 103,
    });
    expect(restored).toEqual(snapshot(state));
    if (!enabled) expect(JSON.stringify(events)).not.toContain('"に"');

    const wrong = choose(state, false);
    const letter = state.panel?.choices.find(
      ({ id }) => id === wrong.payload.choiceId,
    )?.text;
    adjudicate(state, 'actor-0', wrong, 104);
    expect(state.response?.text).toBe(`に${letter}`);
    expect(snapshot(state).response).toEqual(enabled ? state.response : null);
    advance(state, state.deadline as number);
    adjudicate(state, 'actor-1', input(state), 2200);
    expect(state.response).toEqual({ actorId: 'actor-1', text: '' });
    while (state.panel) adjudicate(state, 'actor-1', choose(state), 2201);
    advance(state, state.deadline as number);
    expect(state.response).toBeNull();
  },
);

it.each(['REVEALING', 'ANSWERING', 'JUDGED'] as const)(
  '30-second wait freezes %s and resumes its remaining deadline',
  (phase) => {
    const state = playing(2);
    if (phase === 'ANSWERING') adjudicate(state, 'actor-0', input(state), 100);
    if (phase === 'JUDGED') {
      adjudicate(state, 'actor-0', input(state), 100);
      while (state.panel) adjudicate(state, 'actor-0', choose(state), 101);
    }
    const deadline = state.deadline as number;
    const panel = structuredClone(state.panel);
    const revealed = state.revealed;
    updateConnections(state, new Set(['actor-0']), 200);
    expect(state.reconnect).toEqual({ deadline: 30200, remaining: deadline - 200 });
    expect(advance(state, 30200 - 1)).toBe(false);
    expect(state.phase).toBe(phase);
    expect(state.revealed).toBe(revealed);
    updateConnections(state, new Set(['actor-0']), 1000);
    expect(state.reconnect?.deadline).toBe(30200);
    updateConnections(state, new Set(['actor-0', 'actor-1']), 30199);
    expect(state.reconnect).toBeNull();
    expect(state.deadline).toBe(30199 + deadline - 200);
    if (panel) expect(state.panel).toEqual({ ...panel, deadline: state.deadline });
  },
);

it.each([0, 1])('reconnect at grace deadline + %i cannot revive a match', (offset) => {
  const state = playing(2);
  updateConnections(state, new Set(), 100);
  const saved = structuredClone(state);
  updateConnections(saved, new Set(['actor-0', 'actor-1']), 30100 + offset);
  expect(saved.phase).toBe('INVALID');
  expect(saved.result?.reason).toBe('connections');
  expect(saved.reconnect).toBeNull();
});

it('DO: reconnect within grace restores the same answer panel after eviction', async () => {
  const { stub, tokens, sockets } = await room(2);
  try {
    const initial = await current(sockets[0]);
    await receive(
      sockets[0],
      JSON.stringify({
        type: 'buzz',
        commandId: crypto.randomUUID(),
        matchId: initial.snapshot.matchId,
        questionId: initial.snapshot.questionId,
        payload: {},
      }),
      'ack',
    );
    const panel = (await current(sockets[0])).panel;
    sockets[0].close();
    await expect
      .poll(async () => (await current(sockets[1])).snapshot.reconnect)
      .not.toBeNull();
    const paused = (await current(sockets[1])).snapshot.reconnect;
    await evictDurableObject(stub);
    expect((await current(sockets[1])).snapshot.reconnect).toEqual(paused);
    const replacement = await connect(stub, tokens[0]);
    sockets.push(replacement);
    const resumed = await current(replacement);
    expect(resumed.snapshot.reconnect).toBeNull();
    expect(resumed.snapshot.phase).toBe('ANSWERING');
    expect(resumed.panel?.panelId).toBe(panel?.panelId);
    expect(resumed.panel?.choices).toEqual(panel?.choices);
    expect(resumed.panel?.deadline).toBe(resumed.snapshot.deadline);
    expect(resumed.snapshot.result).toBeNull();
  } finally {
    for (const socket of sockets) socket.close();
  }
});

vi.mock('../src/worker/catalog/database', () => ({
  loadMatchDefinition: async () => ({ questions }),
}));
