import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../src/client/features/auth/clerk';

const mocks = vi.hoisted(() => ({
  listener: undefined as (() => void) | undefined,
  token: vi.fn(),
  redirect: vi.fn(),
  signOut: vi.fn(),
  callback: vi.fn(),
  removeListener: vi.fn(),
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
      return mocks.removeListener;
    }
  },
}));

let storage: Map<string, string>;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  storage = new Map();
  mocks.token.mockReset().mockResolvedValue('session-token');
  mocks.session = { id: 'sess_fixture', getToken: mocks.token };
  mocks.user = { id: 'user_fixture' };
  request = vi.fn(async () => Response.json({ subject: 'legacy-subject' }));
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('location', new URL('https://quiz.test/game/'));
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null });
});
afterEach(() => vi.unstubAllGlobals());

it('検証済みの旧IDを使い、トークン更新のたびに本人IDを再取得しない', async () => {
  const client = createClerkAuth('public-fixture');
  const listener = vi.fn();
  client.auth.onAuthStateChange(listener);
  expect(await client.auth.initialize()).toEqual({ error: null });
  await vi.waitFor(() =>
    expect(listener).toHaveBeenCalledWith(
      'INITIAL_SESSION',
      expect.objectContaining({ user: { id: 'legacy-subject', user_metadata: {} } }),
    ),
  );
  expect((await client.auth.getUser()).data.user?.id).toBe('legacy-subject');
  mocks.token.mockResolvedValue('refreshed-token');
  expect((await client.auth.getSession()).data.session?.access_token).toBe(
    'refreshed-token',
  );
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    '/api/auth/identity',
    expect.objectContaining({ headers: { Authorization: 'Bearer session-token' } }),
  );
  await client.auth.dispose();
});
it('本人確認の通信失敗は未ログインと区別し、再試行で回復する', async () => {
  request.mockRejectedValue(new Error('offline'));
  const client = createClerkAuth('public-fixture');
  const first = await client.auth.getSession();
  expect(first.error).not.toBeNull();
  request.mockImplementation(async () => Response.json({ subject: 'legacy-subject' }));
  expect((await client.auth.getUser()).data.user?.id).toBe('legacy-subject');
  await client.auth.dispose();
});
it('ログアウト後に届いた古い本人確認でログイン状態を復活させない', async () => {
  let complete: (value: Response) => void = () => {};
  request.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  const client = createClerkAuth('public-fixture');
  const listener = vi.fn();
  client.auth.onAuthStateChange(listener);
  const initial = client.auth.initialize();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  mocks.session = null;
  mocks.user = null;
  mocks.listener?.();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('INITIAL_SESSION', null));
  complete(Response.json({ subject: 'legacy-subject' }));
  expect((await initial).error).not.toBeNull();
  expect(listener).toHaveBeenCalledTimes(1);
  await client.auth.dispose();
});
it('Googleだけを使い、外部URLを戻り先にしない', async () => {
  storage.set('quiz-relay-auth-return', 'https://evil.test/');
  const client = createClerkAuth('public-fixture');
  await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: 'https://quiz.test/' },
  });
  expect(mocks.redirect).toHaveBeenCalledWith({
    strategy: 'oauth_google',
    redirectUrl: 'https://quiz.test/game/?clerk-callback=1',
    redirectUrlComplete: 'https://quiz.test/game/',
  });
  await client.auth.signOut({ scope: 'local' });
  expect(mocks.signOut).toHaveBeenCalledWith({ sessionId: 'sess_fixture' });
  await client.auth.dispose();
});
it('保存領域が使えなくても、指定された同一サイトの参加承認画面へ戻れる', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('storage unavailable');
    },
  });
  const client = createClerkAuth('public-fixture');
  const destination =
    'https://quiz.test/authorize-participation/?host=https%3A%2F%2Fhost.quiz-relay.workers.dev&source=12345678-1234-4234-8234-123456789012&instance=12345678-1234-4234-8234-123456789013&mode=room&state=12345678-1234-4234-8234-123456789014&operation=12345678-1234-4234-8234-123456789015';
  await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: destination },
  });
  expect(mocks.redirect).toHaveBeenLastCalledWith(
    expect.objectContaining({
      redirectUrlComplete: destination,
    }),
  );
  await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: 'https://evil.test/game/' },
  });
  expect(mocks.redirect).toHaveBeenLastCalledWith(
    expect.objectContaining({
      redirectUrlComplete: 'https://quiz.test/game/',
    }),
  );
  await client.auth.dispose();
});
