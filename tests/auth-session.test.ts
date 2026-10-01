import {
  AuthApiError,
  createClient,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuth } from '../src/client/features/auth/useAuth';
import { withdrawalReceiptKey } from '../src/client/features/profile/withdrawalReceipt';

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => (() => void) | undefined)[],
  client: null as SupabaseClient | null,
  cleanup: undefined as (() => void) | undefined,
  request: vi.fn(),
}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (value: unknown) => {
    const index = h.cursor++;
    if (index >= h.slots.length) h.slots[index] = value;
    return [
      h.slots[index],
      (next: unknown) => {
        h.slots[index] = next;
      },
    ];
  },
  useEffect: (callback: () => (() => void) | undefined) => h.effects.push(callback),
}));
vi.mock('../src/client/features/auth/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/features/auth/client')>()),
  setupAuth: async () => h.client,
}));

const subject = '00000000-0000-4000-8000-000000000001';
const user: User = {
  id: subject,
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
};
function render() {
  h.cursor = 0;
  h.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: 既存の状態保持ハーネスでSDK通知後の再描画を検証する。
  return useAuth();
}
async function mount() {
  render();
  h.cleanup = h.effects[0]() ?? undefined;
  await vi.waitFor(() => expect(render().ready).toBe(true));
}
function configure(expired = false) {
  const now = Math.floor(Date.now() / 1000);
  const exp = expired ? now - 3600 : now + 3600;
  const accessToken = `${btoa('{"alg":"HS256","typ":"JWT"}')}.${btoa(JSON.stringify({ sub: subject, exp, iat: now - 7200, aud: 'authenticated' }))}.dummy`;
  const storage = new Map([
    [
      'auth-session-review',
      JSON.stringify({
        access_token: accessToken,
        refresh_token: 'dummy-refresh',
        expires_at: exp,
        expires_in: 3600,
        token_type: 'bearer',
        user,
      }),
    ],
  ]);
  h.client = createClient('https://review-auth.invalid', 'dummy-public-key', {
    auth: {
      storageKey: 'auth-session-review',
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
        removeItem: (key) => {
          storage.delete(key);
        },
      },
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: h.request },
  });
  return h.client;
}
async function expire(client: SupabaseClient) {
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200000);
  await client.auth.refreshSession();
  expect((await client.auth.getSession()).data.session).toBeNull();
}
function expectLogin() {
  expect(render().user).toBeNull();
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/game/');
  expect(window.dispatchEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'popstate' }),
  );
}

beforeEach(() => {
  h.slots = [];
  h.cleanup = undefined;
  h.request.mockReset().mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== 'https://review-auth.invalid') throw new Error('NETWORK_BLOCKED');
    if (url.pathname === '/auth/v1/user') return Response.json(user);
    if (url.pathname === '/auth/v1/token')
      return Response.json(
        { code: 'refresh_token_not_found', message: 'review session expired' },
        { status: 400 },
      );
    if (url.pathname === '/auth/v1/logout')
      return Response.json({ message: 'review service unavailable' }, { status: 503 });
    throw new Error('UNEXPECTED_REQUEST');
  });
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('location', {
    href: 'https://quiz.example/users/?instance=one&actor=target#profile',
  });
  vi.stubGlobal('history', {
    replaceState: vi.fn((_state, _title, href: string) => {
      vi.stubGlobal('location', { href: new URL(href, location.href).href });
    }),
  });
  vi.stubGlobal('PopStateEvent', Event);
});
afterEach(async () => {
  h.cleanup?.();
  await h.client?.auth.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('起動前に失効通知が終わった期限切れセッションもログイン画面へ戻す', async () => {
  const client = configure(true);
  await client.auth.initialize();
  await mount();
  expectLogin();
});

it('利用中の更新トークン失効でSDKが認証を解除したらログイン画面へ戻す', async () => {
  const client = configure();
  await mount();
  expect(render().user?.id).toBe(subject);
  expect(history.replaceState).not.toHaveBeenCalled();
  await expire(client);
  expectLogin();
});

it('アクセストークンが有効な間の更新失敗ではログイン状態を維持する', async () => {
  const client = configure();
  await mount();
  const { error } = await client.auth.refreshSession();
  expect(error?.status).toBe(400);
  expect(render().user?.id).toBe(subject);
  expect(history.replaceState).not.toHaveBeenCalled();
});

it('本人確認の一時障害だけではSDKが保持するログイン状態を解除しない', async () => {
  const client = configure();
  vi.spyOn(client.auth, 'getUser').mockResolvedValueOnce({
    data: { user: null },
    error: new AuthApiError('review service unavailable', 503, 'service_unavailable'),
  });
  await mount();
  expect(render().user?.id).toBe(subject);
  expect(history.replaceState).not.toHaveBeenCalled();
  expect(render().message).toContain('確認できませんでした');
});

it('ログアウト503でも実SDKがローカル認証を破棄したらログイン画面へ戻す', async () => {
  const client = configure();
  await mount();
  const { error } = await client.auth.signOut();
  expect(error?.status).toBe(503);
  expect((await client.auth.getSession()).data.session).toBeNull();
  expectLogin();
});

it('認証切れ後に古い本人確認が届いてもログイン状態を復活させない', async () => {
  const client = configure();
  let complete!: (value: { data: { user: User }; error: null }) => void;
  const request = vi.spyOn(client.auth, 'getUser').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  render();
  h.cleanup = h.effects[0]() ?? undefined;
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  await client.auth.signOut();
  complete({ data: { user }, error: null });
  await vi.waitFor(() => expect(render().ready).toBe(true));
  expectLogin();
});

it.each(['INITIAL_SESSION', 'SIGNED_OUT'])(
  '退会手続き情報がある専用画面では%sの後も処理状況画面を残す',
  async (event) => {
    vi.stubGlobal('location', { href: 'https://quiz.example/account/?view=withdrawal' });
    sessionStorage.setItem(
      withdrawalReceiptKey,
      JSON.stringify({ id: 'withdrawal-operation', subject }),
    );
    const client = configure(event === 'INITIAL_SESSION');
    if (event === 'INITIAL_SESSION') await client.auth.initialize();
    await mount();
    if (event === 'SIGNED_OUT') await client.auth.signOut({ scope: 'local' });
    expect(render().user).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  },
);

it.each(['none', 'broken', 'another-user'])(
  '退会画面でも受付情報が%sならセッション切れで移動する',
  async (receipt) => {
    vi.stubGlobal('location', { href: 'https://quiz.example/account/?view=withdrawal' });
    if (receipt !== 'none')
      sessionStorage.setItem(
        withdrawalReceiptKey,
        receipt === 'broken'
          ? '{'
          : JSON.stringify({ id: 'old-operation', subject: 'another-user' }),
      );
    const client = configure();
    await mount();
    await expire(client);
    expectLogin();
  },
);

it('退会の受付情報があっても別画面での失効は移動する', async () => {
  sessionStorage.setItem(
    withdrawalReceiptKey,
    JSON.stringify({ id: 'old-operation', subject }),
  );
  const client = configure();
  await mount();
  await expire(client);
  expectLogin();
});
