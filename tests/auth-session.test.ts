import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthClient, AuthUser } from '../src/client/features/auth/clerk';
import { publicPlayEntry } from '../src/client/features/auth/publicEntry';
import { useAuth } from '../src/client/features/auth/useAuth';
import { withdrawalReceiptKey } from '../src/client/features/profile/withdrawalReceipt';

const mocks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => (() => void) | undefined)[],
  client: null as AuthClient | null,
  cleanup: undefined as (() => void) | undefined,
}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (value: unknown) => {
    const index = mocks.cursor++;
    if (index >= mocks.slots.length) mocks.slots[index] = value;
    return [
      mocks.slots[index],
      (next: unknown) => {
        mocks.slots[index] = next;
      },
    ];
  },
  useEffect: (callback: () => (() => void) | undefined) => mocks.effects.push(callback),
}));
vi.mock('../src/client/features/auth/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/features/auth/client')>()),
  setupAuth: async () => mocks.client,
}));

const subject = 'user_fixture';
it.each([
  ['/game/?instance=sample', true],
  ['/casual/?instance=sample', true],
  ['/rooms/?instance=sample', true],
  ['/rooms/?room=sample&invite=sample', true],
  ['/game/?guest=1', true],
  ['/game/', false],
  ['/game/?instance=sample&view=settings', false],
  ['/profile/', false],
])('公開参加先%sだけを未ログインで保持する', (path, expected) => {
  expect(publicPlayEntry(new URL(`https://quiz.test${path}`))).toBe(expected);
});

function render() {
  mocks.cursor = 0;
  mocks.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: 状態保持ハーネスで認証通知後の再描画を検証する。
  return useAuth();
}
async function mount() {
  render();
  mocks.cleanup = mocks.effects[0]() ?? undefined;
  await vi.waitFor(() => expect(render().ready).toBe(true));
}
function configure(initial: AuthUser | null) {
  const listeners = new Set<(user: AuthUser | null) => void>();
  const client = {
    getToken: vi.fn(),
    getUser: vi.fn(async () => initial),
    subscribe: vi.fn((listener: (user: AuthUser | null) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    signInWithGoogle: vi.fn(),
    signOut: vi.fn(),
  };
  mocks.client = client;
  return {
    client,
    notify: (user: AuthUser | null) => {
      for (const listener of listeners) listener(user);
    },
  };
}
function expectLogin() {
  expect(render().user).toBeNull();
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/game/');
  expect(window.dispatchEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'popstate' }),
  );
}

beforeEach(() => {
  mocks.slots = [];
  mocks.cleanup = undefined;
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
afterEach(() => {
  mocks.cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('起動時にセッションがなければログイン画面へ戻す', async () => {
  configure(null);
  await mount();
  expectLogin();
});

it('利用中にセッションが失効したらログイン画面へ戻す', async () => {
  const { notify } = configure({ id: subject });
  await mount();
  expect(render().user?.id).toBe(subject);
  expect(history.replaceState).not.toHaveBeenCalled();
  notify(null);
  expectLogin();
});

it('本人確認の一時障害では未ログインと扱わず、移動せずに再試行を促す', async () => {
  const { client } = configure({ id: subject });
  client.getUser.mockRejectedValueOnce(new Error('AUTH_IDENTITY_UNAVAILABLE'));
  await mount();
  expect(history.replaceState).not.toHaveBeenCalled();
  expect(render().message).toContain('確認できませんでした');
});

it('認証切れ後に古い本人確認が届いてもログイン状態を復活させない', async () => {
  const { client, notify } = configure(null);
  let complete!: (value: AuthUser) => void;
  client.getUser.mockImplementationOnce(
    () =>
      new Promise<AuthUser>((resolve) => {
        complete = resolve;
      }),
  );
  render();
  mocks.cleanup = mocks.effects[0]() ?? undefined;
  await vi.waitFor(() => expect(client.getUser).toHaveBeenCalledOnce());
  notify(null);
  complete({ id: subject });
  await vi.waitFor(() => expect(render().ready).toBe(true));
  expectLogin();
});

it.each(['initial', 'expired'])(
  '退会手続き情報がある専用画面では%sの未ログイン後も処理状況画面を残す',
  async (timing) => {
    vi.stubGlobal('location', { href: 'https://quiz.example/account/?view=withdrawal' });
    sessionStorage.setItem(
      withdrawalReceiptKey,
      JSON.stringify({ id: 'withdrawal-operation', subject }),
    );
    const { notify } = configure(timing === 'initial' ? null : { id: subject });
    await mount();
    if (timing === 'expired') notify(null);
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
    const { notify } = configure({ id: subject });
    await mount();
    notify(null);
    expectLogin();
  },
);

it('退会の受付情報があっても別画面での失効は移動する', async () => {
  sessionStorage.setItem(
    withdrawalReceiptKey,
    JSON.stringify({ id: 'old-operation', subject }),
  );
  const { notify } = configure({ id: subject });
  await mount();
  notify(null);
  expectLogin();
});
