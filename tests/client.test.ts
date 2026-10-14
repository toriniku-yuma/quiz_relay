import { beforeEach, expect, it, vi } from 'vitest';
import { rootRedirect } from '../src/client/app/redirect';
import { formatProbeError, probeRequest } from '../src/client/features/debug/api';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  const storage = new Map<string, string>();
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

it.each([
  [401, 'UNAUTHORIZED'],
  [404, 'PROBES_DISABLED'],
  [503, 'AUTH_NOT_CONFIGURED'],
])('preserves API error %s / %s', async (status, code) => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code }), { status: Number(status) }),
      ),
  );

  try {
    await probeRequest('test', '/api/probes/auth-config');
    throw new Error('Expected rejection');
  } catch (error) {
    expect(formatProbeError(error)).toMatchObject({ ok: false, status, code });
  }
});

it('公開設定を一度だけ取得して同じClerkクライアントを使い、不正な設定は拒否する', async () => {
  let config: unknown = { url: 'https://auth.example', publishableKey: 'public' };
  const request = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(config)));
  vi.stubGlobal('fetch', request);

  const { setupAuth } = await import('../src/client/features/auth/client');

  await expect(setupAuth()).rejects.toThrow('AUTH_NOT_CONFIGURED');
  config = { provider: 'clerk', publishableKey: 'pk_test_fixture' };
  await expect(setupAuth()).rejects.toThrow('AUTH_NOT_CONFIGURED');
  config = { publishableKey: 'pk_test_fixture' };
  const first = await setupAuth();
  expect(await setupAuth()).toBe(first);
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith('/api/auth/config', expect.anything());
});

it('ルートからの転送でクエリとハッシュを保持する', () => {
  expect(rootRedirect(new URL('https://app.example/?instance=a#saved'))).toBe(
    '/game/?instance=a#saved',
  );
  expect(rootRedirect(new URL('https://app.example/'))).toBe('/game/');
  expect(rootRedirect(new URL('https://app.example/debug/'))).toBeNull();
});

it('keeps formal recovery separate by authenticated subject from the default storage', async () => {
  const { readGameSession, saveGameSession } = await import(
    '../src/client/features/game/recovery'
  );
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const room = { id: crypto.randomUUID() };
  saveGameSession({ id: 'room-15' }, null);
  saveGameSession(room, null, 'formal', 'user-a');
  expect(readGameSession('formal', 'user-a')?.room).toEqual(room);
  expect(readGameSession('formal', 'user-b')).toBeNull();
  saveGameSession(null, null, 'formal', 'user-a');
  expect(readGameSession('formal', 'user-a')).toBeNull();
  expect(readGameSession()?.room.id).toBe('room-15');
  vi.unstubAllGlobals();
});
