import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWithdrawal } from '../src/client/features/profile/useWithdrawal';

const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  request: vi.fn(),
  fetch: vi.fn(),
  signOut: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock('react', () => ({
  useEffect: vi.fn(),
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (index >= harness.state.length)
      harness.state.push(typeof initial === 'function' ? initial() : initial);
    return [
      harness.state[index],
      (value: unknown) => {
        harness.state[index] = value;
      },
    ];
  },
}));
vi.mock('../src/client/features/auth/client', () => ({
  setupAuth: async () => ({
    signOut: harness.signOut,
    getUser: harness.getUser,
  }),
}));
vi.mock('../src/client/features/organization/useOrganization', () => ({
  organizationRequest: harness.request,
  OrganizationRequestError: class extends Error {},
}));
function render(subject?: string) {
  harness.cursor = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: 状態保持ハーネスで通信後の再描画を検証する。
  return useWithdrawal(subject);
}
beforeEach(() => {
  harness.state = [];
  for (const mock of [harness.request, harness.fetch, harness.signOut, harness.getUser])
    mock.mockReset();
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal('fetch', harness.fetch);
});
afterEach(() => vi.unstubAllGlobals());

it('応答不明で画面を開き直しても同じ退会要求を再送する', async () => {
  harness.fetch.mockImplementation(async () =>
    Response.json({ accepted: false, ready: false }),
  );
  harness.request.mockRejectedValue(new Error('通信失敗'));
  render('old-user').setConfirmation('退会');
  await render('old-user').submit();
  const first = harness.request.mock.calls[0];
  harness.state = [];
  expect(render('old-user').locked).toBe(true);
  await render('old-user').submit();
  expect(harness.request.mock.calls[1]).toEqual(first);
});

it('古い退会結果が到着しても再登録した別アカウントをログアウトしない', async () => {
  render('old-user').setConfirmation('退会');
  harness.fetch.mockImplementation(async () =>
    Response.json({ accepted: true, ready: true }),
  );
  harness.getUser.mockResolvedValue({ id: 'new-user' });
  await render('old-user').submit();
  expect(harness.signOut).not.toHaveBeenCalled();
  harness.state = [];
  expect(render('new-user').locked).toBe(false);
  expect(render('new-user').accepted).toBe(false);
});

it('受付済みの本人だけローカル認証を破棄し、退会要求を追加しない', async () => {
  render('old-user').setConfirmation('退会');
  harness.fetch.mockImplementation(async () =>
    Response.json({ accepted: true, ready: false }),
  );
  harness.getUser.mockResolvedValue({ id: 'old-user' });
  await render('old-user').submit();
  expect(harness.signOut).toHaveBeenCalledOnce();
  expect(harness.request).not.toHaveBeenCalled();
  expect(render('old-user').accepted).toBe(true);
  expect(render('old-user').ready).toBe(false);
});

it('退会要求を保存できない場合は送信せず、操作を再開できる', async () => {
  const setItem = vi.fn().mockImplementationOnce(() => {
    throw new Error('QUOTA_EXCEEDED');
  });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem, removeItem: vi.fn() });
  render('old-user').setConfirmation('退会');
  await render('old-user').submit();
  expect(render('old-user').busy).toBe(false);
  expect(render('old-user').locked).toBe(false);
  expect(render('old-user').error).toContain('保存に失敗');
  expect(harness.fetch).not.toHaveBeenCalled();
  expect(harness.request).not.toHaveBeenCalled();

  harness.fetch.mockResolvedValue(Response.json({ accepted: false, ready: false }));
  harness.request.mockRejectedValue(new Error('通信失敗'));
  await render('old-user').submit();
  expect(harness.request).toHaveBeenCalledOnce();
  expect(render('old-user').locked).toBe(true);
});
