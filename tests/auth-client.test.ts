import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { signOut } from '../src/client/features/auth/client';
import { API_PATHS } from '../src/shared/api-paths';

const auth = vi.hoisted(() => ({
  getToken: vi.fn(),
  getUser: vi.fn(),
  subscribe: vi.fn(),
  signInWithGoogle: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('../src/client/features/auth/clerk', () => ({ createClerkAuth: () => auth }));

// Only the logout request is observed; the public auth config is served separately.
function stubLogout(request: (path: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
    path === API_PATHS.publicAuthConfig
      ? Promise.resolve(Response.json({ publishableKey: 'pk_test_fixture' }))
      : request(path, init),
  );
}

beforeEach(() => {
  vi.stubGlobal('window', { isSecureContext: true, dispatchEvent: vi.fn() });
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('location', new URL('https://quiz.example/game/'));
  vi.stubGlobal('PopStateEvent', Event);
  auth.getToken.mockReset().mockResolvedValue('test-token');
  auth.signOut.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it('共通ログアウトはゲーム失効・Clerk解除の完了後にゲスト画面へ移動する', async () => {
  let complete: (value: Response) => void = () => {};
  let completeAuth: () => void = () => {};
  auth.signOut.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        completeAuth = resolve;
      }),
  );
  const request = vi.fn(
    (_path: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  stubLogout(request);
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
  completeAuth();
  await expect(operation).resolves.toEqual({ signedOut: true });
  expect(auth.signOut).toHaveBeenCalledOnce();
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/game/?guest=1');
  expect(window.dispatchEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'popstate' }),
  );
});

it.each(['http', 'network'])(
  'ゲーム失効の%s失敗ではClerkのセッションを保持して再試行できる',
  async (failure) => {
    stubLogout(
      failure === 'http'
        ? vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
        : vi.fn().mockRejectedValue(new Error('offline')),
    );
    await expect(signOut()).rejects.toThrow();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
  },
);

it('セッションがなければ認証不能な失効要求は送信しない', async () => {
  auth.getToken.mockResolvedValue(null);
  const request = vi.fn();
  stubLogout(request);
  await signOut();
  expect(request).not.toHaveBeenCalled();
  expect(auth.signOut).toHaveBeenCalledOnce();
});

it.each([true, false])(
  'Clerk解除のエラー時、セッション保持=%sに応じて移動する',
  async (retained) => {
    stubLogout(vi.fn().mockResolvedValue(Response.json({ ok: true })));
    auth.signOut.mockImplementation(async () => {
      if (!retained) auth.getToken.mockResolvedValue(null);
      throw new Error('AUTH_LOGOUT_FAILED');
    });
    await expect(signOut()).rejects.toThrow('AUTH_LOGOUT_FAILED');
    if (retained) expect(history.replaceState).not.toHaveBeenCalled();
    else expect(history.replaceState).toHaveBeenCalledWith(null, '', '/game/?guest=1');
  },
);
it('Clerk解除中にURLが変わっても元の部屋instanceへゲストで戻り、外部自動ログイン指定を残さない', async () => {
  const instance = crypto.randomUUID();
  vi.stubGlobal(
    'location',
    new URL(
      `https://quiz.example/rooms/?instance=${instance}&home=https://home.example&source=source&mode=room`,
    ),
  );
  stubLogout(vi.fn().mockResolvedValue(Response.json({ ok: true })));
  auth.signOut.mockImplementation(async () => {
    vi.stubGlobal('location', new URL('https://quiz.example/game/'));
  });
  await signOut();
  expect(history.replaceState).toHaveBeenCalledWith(
    null,
    '',
    `/rooms/?guest=1&instance=${instance}`,
  );
});
