import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import app from '../src/worker/index';

const runtime = env as unknown as Env;
const bindings: Env = {
  MATCHMAKER: runtime.MATCHMAKER,
  GAME_OWNER: runtime.GAME_OWNER,
  GAME_CONFIG_PROFILE: 'local',
  PROBE: runtime.PROBE,
  GAME_ROOM: runtime.GAME_ROOM,
  ASSETS: runtime.ASSETS,
  PROBES_ENABLED: 'false',
};

const token = 'test-only-token-with-at-least-32-characters';
const enabled = { ...bindings, PROBES_ENABLED: 'true', PROBE_TOKEN: token };
const headers = { Authorization: `Bearer ${token}` };

describe('probe access boundary', () => {
  it('health is public, probes are disabled by default, unknown APIs return JSON 404', async () => {
    expect((await app.request('/api/health', {}, bindings)).status).toBe(200);
    expect((await app.request('/api/probes/do', {}, bindings)).status).toBe(404);
    expect((await app.request('/api/unknown', {}, bindings)).status).toBe(404);
  });
  it('requires the token and rejects cross-origin mutations', async () => {
    expect(
      (await app.request('/api/probes/do', { method: 'POST' }, enabled)).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          '/api/probes/do',
          { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } },
          enabled,
        )
      ).status,
    ).toBe(403);
    expect((await app.request('/api/probes/status', { headers }, enabled)).status).toBe(
      200,
    );
  });
  it('reports missing external configuration explicitly', async () => {
    expect(
      (await app.request('/api/probes/database', { method: 'POST', headers }, enabled))
        .status,
    ).toBe(503);
    expect(
      (await app.request('/api/probes/auth-config', { headers }, enabled)).status,
    ).toBe(503);
  });
});

it('persists concurrent increments and handles an expired alarm only once', async () => {
  const stub = bindings.PROBE.getByName(crypto.randomUUID());

  await Promise.all(Array.from({ length: 8 }, () => stub.increment()));

  expect((await stub.snapshot()).count).toBe(8);

  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.get('count')).toBe(8);
    await state.storage.put('deadline', Date.now() - 1);
  });

  await runDurableObjectAlarm(stub);
  const finished = await stub.snapshot();

  expect(finished.deadline).toBeNull();
  expect(finished.firedAt).toBeTypeOf('number');

  await runInDurableObject(stub, async (instance) => {
    await instance.alarm();
  });
  expect(await stub.snapshot()).toEqual(finished);
});

it('does not fire an alarm before the persisted deadline', async () => {
  const stub = bindings.PROBE.getByName(crypto.randomUUID());

  await stub.increment();

  await runDurableObjectAlarm(stub);
  expect((await stub.snapshot()).firedAt).toBeNull();
  expect((await stub.snapshot()).deadline).toBeTypeOf('number');
});

it('accepts a hibernation WebSocket and serves persisted state', async () => {
  const stub = bindings.PROBE.getByName(crypto.randomUUID());

  await stub.increment();

  const response = await stub.fetch('https://probe.test/socket', {
    headers: { Upgrade: 'websocket' },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error('Expected a WebSocket upgrade');

  socket.accept();
  const message = new Promise<string>((resolve) =>
    socket.addEventListener('message', (e) => resolve(String(e.data)), { once: true }),
  );

  socket.send('snapshot');

  expect(JSON.parse(await message).count).toBe(1);

  socket.close();
});

it('accepts only the configured HTTPS proxy origin, without trusting forwarded headers', async () => {
  const proxyOrigin = 'https://device.example';
  const configured = { ...enabled, PROBE_ORIGIN: proxyOrigin };

  expect(
    (
      await app.request(
        '/api/probes/status',
        { headers: { ...headers, Origin: proxyOrigin } },
        configured,
      )
    ).status,
  ).toBe(200);

  expect(
    (
      await app.request(
        '/api/probes/status',
        {
          headers: {
            ...headers,
            Origin: 'https://evil.example',
            'X-Forwarded-Host': 'evil.example',
            'X-Forwarded-Proto': 'https',
          },
        },
        configured,
      )
    ).status,
  ).toBe(403);

  expect(
    (
      await app.request(
        '/api/probes/status',
        { headers: { ...headers, Origin: proxyOrigin } },
        enabled,
      )
    ).status,
  ).toBe(403);
});
