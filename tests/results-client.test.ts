import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useResults } from '../src/client/features/results/useResults';

const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  effect: undefined as (() => (() => void) | undefined) | undefined,
  session: vi.fn(),
}));
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = harness.state.length;
    harness.state.push(initial);
    return [
      initial,
      (value: unknown) => {
        harness.state[index] = value;
      },
    ];
  },
  useEffect: (effect: typeof harness.effect) => {
    harness.effect = effect;
  },
}));
vi.mock('../src/client/features/auth/client', () => ({
  setupAuth: async () => ({ auth: { getSession: harness.session } }),
}));

const requests: {
  signal: AbortSignal;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}[] = [];
beforeEach(() => {
  harness.state = [];
  harness.effect = undefined;
  requests.length = 0;
  vi.stubGlobal('window', new EventTarget());
  harness.session
    .mockReset()
    .mockResolvedValue({ data: { session: { access_token: 'test' } } });
  vi.stubGlobal(
    'fetch',
    (_path: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        // abort後にも遅れて届く応答を再現し、状態更新側でも排除できるか確認する。
        requests.push({ signal: init.signal as AbortSignal, resolve, reject });
      }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('表示名の変更で再取得し、破棄後は変更通知を受け取らない', async () => {
  useResults('ready');
  const cleanup = harness.effect?.();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  window.dispatchEvent(new Event('profile:refresh'));
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].signal.aborted).toBe(true);
  cleanup?.();
  window.dispatchEvent(new Event('profile:refresh'));
  await Promise.resolve();
  expect(requests).toHaveLength(2);
  for (const request of requests)
    request.resolve(Response.json({ ranking: [], history: [] }));
});

it.each(['success', 'failure'] as const)(
  '古い手動要求の%sで、自動更新後の表示・エラー・busyを上書きしない',
  async (outcome) => {
    const hook = useResults('pending');
    const old = hook.refresh();
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    const cleanup = harness.effect?.(); // 確定通知によるeffectの実行
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].signal.aborted).toBe(true);
    requests[1].resolve(Response.json({ ranking: [{ rating: 1020 }], history: [] }));
    await vi.waitFor(() => expect(harness.state[2]).toBe(false));
    const latest = harness.state[0];

    if (outcome === 'success')
      requests[0].resolve(Response.json({ ranking: [{ rating: 1000 }], history: [] }));
    else requests[0].reject(new Error('late failure'));
    await old;
    expect(harness.state).toEqual([latest, '', false]);
    expect(latest).toEqual({ ranking: [{ rating: 1020 }], history: [] });
    cleanup?.();
  },
);

it('古い要求の完了は新しい要求の読込中状態を解除しない', async () => {
  const hook = useResults('pending');
  const old = hook.refresh();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const latest = hook.refresh();
  await vi.waitFor(() => expect(requests).toHaveLength(2));

  requests[0].resolve(Response.json({ ranking: [], history: [] }));
  await old;
  expect(harness.state).toEqual([null, '', true]);
  requests[1].resolve(Response.json({ ranking: [], history: [] }));
  await latest;
  expect(harness.state[2]).toBe(false);
});

it('effectのcleanupは手動要求も取り消し、破棄後の状態更新を防ぐ', async () => {
  const hook = useResults('pending');
  const cleanup = harness.effect?.();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const manual = hook.refresh();
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  cleanup?.();
  expect(requests.every((request) => request.signal.aborted)).toBe(true);

  requests[0].resolve(Response.json({ ranking: [], history: [] }));
  requests[1].resolve(Response.json({ ranking: [], history: [] }));
  await manual;
  expect(harness.state).toEqual([null, '', true]);
});
