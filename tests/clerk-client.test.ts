import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../src/client/features/auth/clerk';

const mocks = vi.hoisted(() => ({
  listener: undefined as (() => void) | undefined,
  token: vi.fn(),
  redirect: vi.fn(),
  signOut: vi.fn(),
  callback: vi.fn(),
  session: null as { id: string; getToken: ReturnType<typeof vi.fn> } | null,
  user: null as { id: string } | null,
}));
vi.mock('@clerk/clerk-js', () => ({
  Clerk: class {
    get session() {
      return mocks.session;
    }
    get user() {
      return mocks.user;
    }
    client = { signIn: { authenticateWithRedirect: mocks.redirect } };
    load = async () => {};
    handleRedirectCallback = mocks.callback;
    signOut = mocks.signOut;
    addListener(listener: () => void) {
      mocks.listener = listener;
      listener();
      return () => {};
    }
  },
}));

const publishableKey = 'pk_test_fixture';
let storage: Map<string, string>;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  storage = new Map();
  mocks.token.mockReset().mockResolvedValue('session-token');
  mocks.session = { id: 'sess_fixture', getToken: mocks.token };
  mocks.user = { id: 'user_fixture' };
  request = vi.fn(async () => Response.json({ subject: 'user_fixture' }));
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('location', new URL('https://quiz.test/game/'));
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null });
});
afterEach(() => vi.unstubAllGlobals());

it('サーバーが確認したClerkユーザーIDを使い、トークン更新のたびに本人確認を繰り返さない', async () => {
  const client = createClerkAuth(publishableKey);
  expect(await client.getUser()).toEqual({ id: 'user_fixture' });
  mocks.token.mockResolvedValue('refreshed-token');
  expect(await client.getToken()).toBe('refreshed-token');
  expect(await client.getUser()).toEqual({ id: 'user_fixture' });
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    '/api/auth/identity',
    expect.objectContaining({ headers: { Authorization: 'Bearer session-token' } }),
  );
});
it('サーバーの本人IDがClerkユーザーIDと異なれば受け付けない', async () => {
  request.mockImplementation(async () => Response.json({ subject: 'user_other' }));
  const client = createClerkAuth(publishableKey);
  await expect(client.getUser()).rejects.toThrow('INVALID_AUTH_IDENTITY');
});
it('セッションがなければトークンも本人もnullを返す', async () => {
  mocks.session = null;
  mocks.user = null;
  const client = createClerkAuth(publishableKey);
  expect(await client.getToken()).toBeNull();
  expect(await client.getUser()).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
it('本人確認の通信失敗は未ログインと区別し、再試行で回復する', async () => {
  request.mockRejectedValue(new Error('offline'));
  const client = createClerkAuth(publishableKey);
  await expect(client.getUser()).rejects.toThrow('offline');
  request.mockImplementation(async () => Response.json({ subject: 'user_fixture' }));
  expect(await client.getUser()).toEqual({ id: 'user_fixture' });
});
it('ユーザーが変わったときだけ通知し、ログアウト後に届いた古い本人確認で復活させない', async () => {
  let complete: (value: Response) => void = () => {};
  request.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  const client = createClerkAuth(publishableKey);
  const listener = vi.fn();
  client.subscribe(listener);
  const initial = client.getUser();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  mocks.listener?.();
  expect(listener).not.toHaveBeenCalled();
  mocks.session = null;
  mocks.user = null;
  mocks.listener?.();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(null));
  complete(Response.json({ subject: 'user_fixture' }));
  await expect(initial).rejects.toThrow('AUTH_SESSION_CHANGED');
  expect(listener).toHaveBeenCalledOnce();
});
it('Googleだけを使い、保存済みの外部URLを戻り先にしない', async () => {
  storage.set('quiz-relay-auth-return', 'https://evil.test/');
  const client = createClerkAuth(publishableKey);
  await client.signInWithGoogle('/game/');
  expect(mocks.redirect).toHaveBeenCalledWith({
    strategy: 'oauth_google',
    redirectUrl: 'https://quiz.test/game/?clerk-callback=1',
    redirectUrlComplete: 'https://quiz.test/game/',
  });
  await client.signOut();
  expect(mocks.signOut).toHaveBeenCalledWith({ sessionId: 'sess_fixture' });
});
it('指定された同一サイトの参加承認画面へ戻り、外部URLの指定は拒否する', async () => {
  const client = createClerkAuth(publishableKey);
  const destination =
    '/authorize-participation/?host=https%3A%2F%2Fhost.quiz-relay.workers.dev&source=12345678-1234-4234-8234-123456789012&instance=12345678-1234-4234-8234-123456789013&mode=room&state=12345678-1234-4234-8234-123456789014&operation=12345678-1234-4234-8234-123456789015&flow=login';
  await client.signInWithGoogle(destination);
  expect(mocks.redirect).toHaveBeenLastCalledWith(
    expect.objectContaining({ redirectUrlComplete: `https://quiz.test${destination}` }),
  );
  await expect(client.signInWithGoogle('https://evil.test/game/')).rejects.toThrow(
    'INVALID_AUTH_RETURN',
  );
  expect(mocks.redirect).toHaveBeenCalledOnce();
});
it('Clerkのリダイレクト後は保存済みの戻り先で認証を完了する', async () => {
  storage.set('quiz-relay-auth-return', '/debug/');
  vi.stubGlobal('location', new URL('https://quiz.test/game/?clerk-callback=1'));
  await createClerkAuth(publishableKey).getToken();
  expect(mocks.callback).toHaveBeenCalledWith({
    signInFallbackRedirectUrl: '/debug/',
    signUpFallbackRedirectUrl: '/debug/',
  });
});
