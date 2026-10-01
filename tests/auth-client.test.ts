import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { signOut } from '../src/client/features/auth/client';
import { API_PATHS } from '../src/shared/api-paths';

const auth = vi.hoisted(() => ({ getSession: vi.fn(), signOut: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth }) }));

beforeEach(() => {
  vi.stubGlobal('window', { isSecureContext: true, dispatchEvent: vi.fn() });
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('PopStateEvent', Event);
  vi.stubGlobal('localStorage', {
    getItem: () => JSON.stringify({ url: 'https://auth.test', publishableKey: 'test' }),
    removeItem: vi.fn(),
  });
  auth.getSession.mockReset().mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
    error: null,
  });
  auth.signOut.mockReset().mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllGlobals());

it('共通ログアウトはゲーム失効・Auth解除の完了後にログイン画面へ移動する', async () => {
  let complete: (value: Response) => void = () => {};
  let completeAuth: (value: { error: null }) => void = () => {};
  auth.signOut.mockImplementation(
    () =>
      new Promise((resolve) => {
        completeAuth = resolve;
      }),
  );
  const request = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  vi.stubGlobal('fetch', request);
  const operation = signOut();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith(
    API_PATHS.logout,
    expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    }),
  );
  expect(auth.signOut).not.toHaveBeenCalled();
  expect(history.replaceState).not.toHaveBeenCalled();
  complete(Response.json({ ok: true }));
  await vi.waitFor(() => expect(auth.signOut).toHaveBeenCalledOnce());
  expect(history.replaceState).not.toHaveBeenCalled();
  completeAuth({ error: null });
  await expect(operation).resolves.toEqual({ signedOut: true });
  expect(auth.signOut).toHaveBeenCalledOnce();
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/game/');
  expect(window.dispatchEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'popstate' }),
  );
});

it.each(['http', 'network'])(
  'ゲーム失効の%s失敗ではAuthを保持して再試行できる',
  async (failure) => {
    vi.stubGlobal(
      'fetch',
      failure === 'http'
        ? vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
        : vi.fn().mockRejectedValue(new Error('offline')),
    );
    await expect(signOut()).rejects.toThrow();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
  },
);

it('Authセッションがなければ認証不能な失効要求は送信しない', async () => {
  auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  await signOut();
  expect(request).not.toHaveBeenCalled();
  expect(auth.signOut).toHaveBeenCalledOnce();
});

it.each([true, false])(
  'Auth解除のエラー時、セッション保持=%sに応じて移動する',
  async (retained) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true })));
    auth.signOut.mockImplementation(async () => {
      if (!retained)
        auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
      return { error: new Error('AUTH_LOGOUT_FAILED') };
    });
    await expect(signOut()).rejects.toThrow('AUTH_LOGOUT_FAILED');
    if (retained) expect(history.replaceState).not.toHaveBeenCalled();
    else expect(history.replaceState).toHaveBeenCalledWith(null, '', '/game/');
  },
);
