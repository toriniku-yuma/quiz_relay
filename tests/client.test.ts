import { beforeEach, expect, it, vi } from 'vitest';
import { rootRedirect } from '../src/client/app/redirect';
import { formatProbeError, probeRequest } from '../src/client/features/debug/api';

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock('@supabase/supabase-js', () => ({ createClient, isAuthApiError: () => false }));

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

it('reuses matching config and disposes the old client on URL or key changes', async () => {
  createClient.mockImplementation(() => ({
    auth: { dispose: vi.fn().mockResolvedValue(undefined) },
  }));

  let config = { url: 'https://a.example', publishableKey: 'public-a' };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response(JSON.stringify(config))),
  );

  const { setupAuth } = await import('../src/client/features/auth/client');

  const first = await setupAuth('test');

  expect(await setupAuth('test')).toBe(first);

  config = { url: 'https://b.example', publishableKey: 'public-b' };

  const second = await setupAuth('test');

  expect(second).not.toBe(first);
  expect(first.auth.dispose).toHaveBeenCalledOnce();

  config = { ...config, publishableKey: 'rotated' };

  expect(await setupAuth('test')).not.toBe(second);
  expect(second.auth.dispose).toHaveBeenCalledOnce();
  expect(createClient).toHaveBeenCalledTimes(3);
  expect(JSON.parse(localStorage.getItem('probe-auth-config') ?? 'null')).toEqual(config);
});

it('preserves auth query and hash during the root redirect', () => {
  expect(rootRedirect(new URL('https://app.example/?code=test#state=value'))).toBe(
    '/debug/?code=test#state=value',
  );
  expect(rootRedirect(new URL('https://app.example/debug/'))).toBeNull();
});
