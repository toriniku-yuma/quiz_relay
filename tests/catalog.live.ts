import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { loadMatchDefinition } from '../src/worker/catalog/database';
import type { Env } from '../src/worker/env';
import type { State } from '../src/worker/game/state';

// 明示実行のみ。実DBはSELECTだけ、DOはテスト専用のランダム名。
it.each([
  { version: 1, players: 4 },
  { version: 2, players: 2 },
])(
  'live DB: fixed catalog $version starts with $players players',
  async ({ version, players }) => {
    const runtime = env as unknown as Env;
    const definition = await loadMatchDefinition(runtime, {
      owner: runtime.GAME_OWNER,
      id: 'demo',
      version,
    });
    expect(definition.playersPerMatch).toBe(players);
    expect(definition.questions).toHaveLength(12);
    const room = runtime.GAME_ROOM.getByName(`catalog-live:${crypto.randomUUID()}`);
    const sockets: WebSocket[] = [];
    try {
      for (let i = 0; i < players; i++) {
        expect((await room.reserve(`a${i}`, `P${i}`, `t${i}`, definition)).ok).toBe(true);
        const response = await room.fetch('https://game.test', {
          headers: { Upgrade: 'websocket', 'X-Game-Session': `t${i}` },
        });
        expect(response.status).toBe(101);
        const socket = response.webSocket as WebSocket;
        socket.accept();
        sockets.push(socket);
        const state = await runInDurableObject(
          room,
          async (_instance, ctx) =>
            (await ctx.storage.get<{ state: State }>('room'))?.state,
        );
        expect(state?.phase).toBe(i === players - 1 ? 'REVEALING' : 'WAITING');
        expect(state?.definition?.manifestHash).toBe(definition.manifestHash);
      }
    } finally {
      for (const socket of sockets) socket.close();
    }
  },
  30000,
);

it('live DB: local development rooms also load their questions from the catalog', async () => {
  const runtime = env as unknown as Env;
  const definition = await loadMatchDefinition(runtime);
  const room = runtime.GAME_ROOM.getByName(`local-catalog-live:${crypto.randomUUID()}`);
  const result = await room.join({ name: 'QA', players: 2, questionIndex: 1 }, undefined);
  expect(result.ok).toBe(true);
  const stored = await runInDurableObject(room, async (_instance, ctx) =>
    ctx.storage.get<{ state: State }>('room'),
  );
  expect(stored?.state.question).toEqual(definition.questions[1]);
  expect(stored?.state.questions).toHaveLength(definition.questions.length);
}, 30000);
