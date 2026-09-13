import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Command, GameMessage } from '../src/shared/game';
import type { Env } from '../src/worker/env';
import { choicesFor, graphemes, questions } from '../src/worker/game/questions';
import {
  adjudicate,
  advance,
  createState,
  rules,
  type State,
  snapshot,
} from '../src/worker/game/state';
import { parseCommand, parseJoin } from '../src/worker/game/validation';
import app from '../src/worker/index';

const runtime = env as unknown as Env;

function playing() {
  const state = createState(0, 2);
  state.players = ['alice', 'bob'].map((id) => ({
    id,
    name: id,
    correct: 0,
    mistakes: 0,
    locked: false,
    disqualified: false,
    connected: true,
  }));
  state.phase = 'REVEALING';
  state.deadline = 10000;
  return state;
}

function command(state: State, type: Command['type'] = 'buzz'): Command {
  return {
    commandId: crypto.randomUUID(),
    matchId: state.matchId,
    questionId: state.question.id,
    type,
    payload: {},
  };
}

function select(state: State, correct: boolean): Command {
  const panel = state.panel;
  if (!panel) throw new Error('Expected panel');
  const expected = graphemes(state.question.answer)[panel.position];
  const choice = panel.choices.find(({ text }) =>
    correct ? text === expected : text !== expected,
  );
  return {
    ...command(state, 'choose'),
    payload: { attemptId: panel.attemptId, panelId: panel.panelId, choiceId: choice?.id },
  };
}

describe('1A adjudication', () => {
  it('G01/G03: only the first valid buzz wins and other actors cannot answer', () => {
    const state = playing();

    expect(adjudicate(state, 'alice', command(state), 100).ok).toBe(true);
    expect(adjudicate(state, 'bob', command(state), 100).code).toBe('BUZZ_REJECTED');
    expect(adjudicate(state, 'bob', select(state, true), 101).code).toBe(
      'PANEL_REJECTED',
    );

    expect(state.holder).toBe('alice');
    expect(state.roomSeq).toBe(1);
    expect(state.players.map(({ correct }) => correct)).toEqual([0, 0]);
  });

  it('G02/G09: replay keeps the original reply and panel; changed contents conflict', () => {
    const state = playing();
    adjudicate(state, 'alice', command(state), 100);
    const input = select(state, true);

    const reply = adjudicate(state, 'alice', input, 200);
    const panel = structuredClone(state.panel);
    expect(adjudicate(state, 'alice', input, 400)).toEqual(reply);
    expect(state.panel).toEqual(panel);
    expect(
      adjudicate(
        state,
        'alice',
        { ...input, payload: { ...input.payload, choiceId: 'different' } },
        500,
      ).code,
    ).toBe('COMMAND_CONFLICT');
    expect(
      adjudicate(state, 'alice', { ...input, commandId: crypto.randomUUID() }, 600).code,
    ).toBe('PANEL_REJECTED');
    expect(state.players[0].correct).toBe(0);
  });

  it.each([-1, 0, 1])(
    'G04/G17/G19: deadline boundary %i is checked even without alarm delivery',
    (delta) => {
      const state = playing();
      adjudicate(state, 'alice', command(state), 100);
      expect(state.panel?.deadline).toBe(3100);
      const input = select(state, true);

      const reply = adjudicate(state, 'alice', input, 3100 + delta);

      expect(reply.ok).toBe(delta < 0);
      expect(state.players[0].mistakes).toBe(delta < 0 ? 0 : 1);
      if (delta >= 0) {
        adjudicate(state, 'alice', input, 3200);
        advance(state, 3200);
        expect(state.players[0].mistakes).toBe(1);
      }
    },
  );

  it('G11: NFKC, combining marks, small kana and long vowels use graphemes and unique choices', () => {
    expect(graphemes('  ｶﾞキ\u3099ャー  ')).toEqual(['ガ', 'ギ', 'ャ', 'ー']);
    expect(questions.length).toBeGreaterThanOrEqual(10);
    expect(graphemes('  がき\u3099ゃー  ')).toEqual(['が', 'ぎ', 'ゃ', 'ー']);

    for (const question of questions) {
      for (const letter of graphemes(question.answer)) {
        const choices = choicesFor(letter);
        expect(choices).toHaveLength(4);
        expect(choices.every(({ text }) => /^[ぁ-ゖー]$/u.test(text))).toBe(true);
        expect(new Set(choices.map(({ text }) => text)).size).toBe(4);
        expect(choices.filter(({ text }) => text === letter)).toHaveLength(1);
      }
    }
  });

  it('G12/G13: incorrect letter locks this question; other actor resumes at the frozen position', () => {
    const state = playing();
    state.revealed = 3;
    adjudicate(state, 'alice', command(state), 100);

    adjudicate(state, 'alice', select(state, false), 200);
    expect(state.judgment?.result).toBe('wrong');
    expect(state.players[0].mistakes).toBe(1);
    expect(state.players[0].locked).toBe(true);
    advance(state, 2200);

    expect(state.phase).toBe('REVEALING');
    expect(state.revealed).toBe(3);
    expect(adjudicate(state, 'alice', command(state), 2201).ok).toBe(false);
    expect(adjudicate(state, 'bob', command(state), 2201).ok).toBe(true);
  });

  it('G13/G18: next character gets a new deadline; an old timer cannot expire it', () => {
    const state = playing();
    adjudicate(state, 'alice', command(state), 100);
    adjudicate(state, 'alice', select(state, true), 1000);

    expect(state.panel?.deadline).toBe(4000);
    expect(advance(state, 3100)).toBe(false);
    expect(state.phase).toBe('ANSWERING');
    adjudicate(state, 'alice', select(state, true), 3200);

    expect(state.players[0].correct).toBe(1);
    expect(state.judgment?.result).toBe('correct');
    advance(state, 5200);
    expect(state.phase).toBe('REVEALING');
    expect(state.questionIndex).toBe(1);
  });

  it('G12: full reveal waits ten seconds and an incorrect answer preserves remaining wait', () => {
    const state = playing();
    state.revealed = graphemes(state.question.text).length - 1;
    advance(state, 10000);
    expect(state.deadline).toBe(20000);

    adjudicate(state, 'alice', command(state), 15000);
    adjudicate(state, 'alice', select(state, false), 15100);
    advance(state, 17100);
    expect(state.deadline).toBe(22100);
    expect(advance(state, 22099)).toBe(false);
    advance(state, 22100);
    expect(state.judgment?.result).toBe('unanswered');
  });

  it('G03/G08: stale match/question rejected and public snapshot contains only revealed text', () => {
    const state = playing();
    state.revealed = 2;

    expect(
      adjudicate(state, 'alice', { ...command(state), matchId: 'old' }, 100).ok,
    ).toBe(false);
    expect(
      adjudicate(state, 'alice', { ...command(state), questionId: 'old' }, 100).ok,
    ).toBe(false);
    adjudicate(state, 'alice', command(state), 100);
    const publicState = snapshot(state);

    expect(publicState.text).toBe(graphemes(state.question.text).slice(0, 2).join(''));
    expect(publicState).not.toHaveProperty('panel');
    expect(publicState).not.toHaveProperty('question');
    expect(JSON.stringify(publicState)).not.toContain(state.question.answer);
    expect(JSON.stringify(publicState)).not.toContain(state.question.text);
  });

  it('rejects malformed, oversized, extra-field and position-skipping inputs', () => {
    const state = playing();
    expect(parseCommand(JSON.stringify(command(state)))).not.toBeNull();
    for (const input of [
      '{',
      '{}',
      'x'.repeat(2049),
      JSON.stringify({ ...command(state), actorId: 'alice' }),
      JSON.stringify({ ...command(state, 'choose'), payload: { position: 2 } }),
    ]) {
      expect(parseCommand(input)).toBeNull();
    }
    expect(parseJoin({ name: 'A', players: 2, questionIndex: 0 })?.showSelections).toBe(
      true,
    );
    expect(
      parseJoin({ name: 'A', players: 2, questionIndex: 0, showSelections: false })
        ?.showSelections,
    ).toBe(false);
    expect(
      parseJoin({ name: 'A', players: 2, questionIndex: 0, showSelections: 'false' }),
    ).toBeNull();
    expect(parseJoin({ name: ' ', players: 2, questionIndex: 0 })).toBeNull();
    expect(parseJoin({ name: 'A', players: 5, questionIndex: 0 })).toBeNull();
  });
});

async function socketFor(
  stub: DurableObjectStub<import('../src/worker/game/GameRoom').GameRoom>,
  token: string,
) {
  const response = await stub.fetch('https://room.test', {
    headers: { Upgrade: 'websocket', 'X-Game-Session': token },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error('WebSocket upgrade failed');
  socket.accept();
  return { socket };
}

async function nextMessage(
  socket: WebSocket,
  predicate: (message: GameMessage) => boolean,
  send: string,
): Promise<GameMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', listener);
      reject(new Error('Message timeout'));
    }, 2000);
    function listener(event: MessageEvent) {
      const message = JSON.parse(String(event.data)) as GameMessage;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', listener);
      resolve(message);
    }
    socket.addEventListener('message', listener);
    socket.send(send);
  });
}

it('DO G01/G02/G08/G09: concurrent sockets, durable ack, private panel and duplicate replay', async () => {
  const stub = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  const first = await stub.join({ name: 'A', players: 2, questionIndex: 0 }, undefined);
  const second = await stub.join({ name: 'B', players: 2, questionIndex: 0 }, undefined);
  if (!first.ok || !second.ok) throw new Error('join failed');
  const a = await socketFor(stub, first.token);
  const b = await socketFor(stub, second.token);

  try {
    const initial = await nextMessage(
      a.socket,
      (message) => message.type === 'state' && message.snapshot.phase === 'REVEALING',
      'sync',
    );
    if (initial.type !== 'state') throw new Error('Expected state');
    const buzz: Command = {
      commandId: crypto.randomUUID(),
      matchId: initial.snapshot.matchId,
      questionId: initial.snapshot.questionId,
      type: 'buzz',
      payload: {},
    };
    const other = { ...buzz, commandId: crypto.randomUUID() };

    const replies = await Promise.all([
      nextMessage(a.socket, (m) => m.type === 'ack', JSON.stringify(buzz)),
      nextMessage(b.socket, (m) => m.type === 'ack', JSON.stringify(other)),
    ]);
    expect(replies.filter((m) => m.type === 'ack' && m.reply.ok)).toHaveLength(1);
    const aWon = replies[0].type === 'ack' && replies[0].reply.ok;
    const winner = aWon ? a : b;
    const loser = aWon ? b : a;
    const original = aWon ? buzz : other;
    const replay = await nextMessage(
      winner.socket,
      (m) => m.type === 'ack',
      JSON.stringify(original),
    );
    expect(replay).toEqual(aWon ? replies[0] : replies[1]);

    const own = await nextMessage(winner.socket, (m) => m.type === 'state', 'sync');
    const publicMessage = await nextMessage(
      loser.socket,
      (m) => m.type === 'state',
      'sync',
    );
    expect(own.type === 'state' && own.panel?.choices).toHaveLength(4);
    expect(publicMessage.type === 'state' && publicMessage.panel).toBeNull();
    expect(JSON.stringify(publicMessage)).not.toContain(first.token);
    expect(JSON.stringify(publicMessage)).not.toContain(questions[0].text);

    await runInDurableObject(stub, async (_instance, ctx) => {
      const saved = await ctx.storage.get<{ state: State }>('room');
      expect(saved?.state.phase).toBe('ANSWERING');
      expect(Object.keys(saved?.state.commands ?? {})).toHaveLength(2);
      expect(saved?.state.panel).toEqual(own.type === 'state' ? own.panel : null);
    });
  } finally {
    a.socket.close();
    b.socket.close();
  }
});

it('DO G04/G17: alarm timeout is persisted once and duplicate alarm does not add mistakes', async () => {
  const stub = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  const sockets: WebSocket[] = [];
  for (const name of ['A', 'B']) {
    const joined = await stub.join({ name, players: 2, questionIndex: 0 }, undefined);
    if (!joined.ok) throw new Error('join failed');
    sockets.push((await socketFor(stub, joined.token)).socket);
  }

  try {
    await runInDurableObject(stub, async (_instance, ctx) => {
      const saved = await ctx.storage.get<{
        state: State;
        sessions: Record<string, string>;
      }>('room');
      if (!saved) throw new Error('Missing room');
      adjudicate(
        saved.state,
        saved.state.players[0].id,
        command(saved.state),
        Date.now() - rules.characterAnswerTimeMs - 1,
      );
      await ctx.storage.put('room', saved);
      await ctx.storage.setAlarm(Date.now() - 1);
    });
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance, ctx) => {
      const saved = await ctx.storage.get<{ state: State }>('room');
      expect(saved?.state.players[0].mistakes).toBe(1);
      expect(saved?.state.judgment?.result).toBe('timeout');
    });
  } finally {
    for (const socket of sockets) socket.close();
  }
});

it('local game API denies disabled access, cross-origin requests, missing sessions and invalid room', async () => {
  const bindings = { ...runtime, LOCAL_GAME_ENABLED: 'true' };
  const headers = { Origin: 'http://localhost' };

  expect(
    (
      await app.request(
        '/api/game/join?room=room-1',
        { method: 'POST', headers },
        { ...bindings, LOCAL_GAME_ENABLED: 'false' },
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await app.request(
        '/api/game/join?room=room-1',
        { method: 'POST', headers: { Origin: 'https://evil.example' } },
        bindings,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        '/api/game/join?room=invalid',
        { method: 'POST', headers },
        bindings,
      )
    ).status,
  ).toBe(400);
  expect(
    (await app.request('/api/game/socket?room=room-1', { headers }, bindings)).status,
  ).toBe(401);
  expect(
    (
      await app.request(
        '/api/game/join?room=room-1',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'A', players: 2, questionIndex: 0 }),
        },
        bindings,
      )
    ).status,
  ).toBe(200);
});

it('keeps fixed rules and old ACKs when the 1A command budget is exhausted', () => {
  const state = playing();
  expect(state.rules).toEqual({ ...rules, showSelections: true });
  expect(state.rules).not.toBe(rules);
  const buzz = command(state);
  const first = adjudicate(state, 'alice', buzz, 100);

  for (let i = 1; i < 256; i++)
    adjudicate(state, 'alice', { ...command(state), matchId: 'old' }, 101);

  expect(adjudicate(state, 'alice', buzz, 102)).toEqual(first);
  expect(adjudicate(state, 'alice', select(state, true), 103).code).toBe('COMMAND_LIMIT');
  expect(state.players[0].correct).toBe(0);
});

it('rejects an oversized join body before parsing', async () => {
  const response = await app.request(
    '/api/game/join?room=room-1',
    {
      method: 'POST',
      headers: { Origin: 'http://localhost' },
      body: 'x'.repeat(1025),
    },
    { ...runtime, LOCAL_GAME_ENABLED: 'true' },
  );

  expect(response.status).toBe(413);
});

it('one actor cannot consume another actors command allowance', () => {
  const state = playing();

  for (let i = 0; i < 256; i++)
    adjudicate(state, 'alice', { ...command(state), matchId: 'old' }, 100);
  expect(adjudicate(state, 'alice', command(state), 101).code).toBe('COMMAND_LIMIT');

  expect(adjudicate(state, 'bob', command(state), 102).ok).toBe(true);
  expect(state.holder).toBe('bob');
  expect(adjudicate(state, 'bob', select(state, true), 103).ok).toBe(true);
});

it('rejects a fourth connection during join and allows it again after a tab closes', async () => {
  const stub = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  const input = { name: 'A', players: 2, questionIndex: 0 };
  const joined = await stub.join(input, undefined);
  if (!joined.ok) throw new Error('join failed');
  const sockets: WebSocket[] = [];

  try {
    for (let i = 0; i < 3; i++)
      sockets.push((await socketFor(stub, joined.token)).socket);
    expect(await stub.join(input, joined.token)).toEqual({
      ok: false,
      code: 'CONNECTION_LIMIT',
    });
    const response = await stub.fetch('https://room.test', {
      headers: { Upgrade: 'websocket', 'X-Game-Session': joined.token },
    });
    expect(response.status).toBe(429);

    sockets[0].close();
    await expect.poll(async () => (await stub.join(input, joined.token)).ok).toBe(true);
    sockets.push((await socketFor(stub, joined.token)).socket);
  } finally {
    for (const socket of sockets) socket.close();
  }
});
