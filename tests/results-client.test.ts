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
        harness.state[index] =
          typeof value === 'function' ? value(harness.state[index]) : value;
      },
    ];
  },
  useEffect: (effect: typeof harness.effect) => {
    harness.effect = effect;
  },
}));
vi.mock('../src/client/features/auth/client', () => ({
  authToken: harness.session,
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
  harness.session.mockReset().mockResolvedValue('test');
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

it.each(['self', 'ranking'] as const)(
  '%sは同じインスタンスの保存確定だけで再取得し、破棄後は通知を受け取らない',
  async (section) => {
    useResults('ready', 'instance-a', { section });
    const cleanup = harness.effect?.();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    window.dispatchEvent(
      new CustomEvent('results:refresh', { detail: { instanceId: 'instance-b' } }),
    );
    await Promise.resolve();
    expect(requests).toHaveLength(1);

    window.dispatchEvent(
      new CustomEvent('results:refresh', { detail: { instanceId: 'instance-a' } }),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].signal.aborted).toBe(true);
    requests[1].resolve(
      Response.json({ ranking: [], history: [], self: { rank: 104, rating: 980 } }),
    );
    await vi.waitFor(() => expect(harness.state[2]).toBe(false));
    requests[0].resolve(
      Response.json({ ranking: [], history: [], self: { rank: 1, rating: 1000 } }),
    );
    await Promise.resolve();
    expect(harness.state[0]).toEqual({
      ranking: [],
      history: [],
      self: { rank: 104, rating: 980 },
    });

    cleanup?.();
    window.dispatchEvent(
      new CustomEvent('results:refresh', { detail: { instanceId: 'instance-a' } }),
    );
    await Promise.resolve();
    expect(requests).toHaveLength(2);
  },
);

it('順位の保存確定通知で、追加表示済みの履歴とcursorを巻き戻さない', async () => {
  useResults('ready', 'instance-a', { section: 'history' });
  const cleanup = harness.effect?.();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const history = {
    ranking: [],
    history: Array.from({ length: 40 }, (_, i) => ({ matchId: `result-${i}` })),
    nextCursor: { finishedAt: '2026-10-01T00:00:00.000Z', matchId: 'cursor' },
  };
  requests[0].resolve(Response.json(history));
  await vi.waitFor(() => expect(harness.state[2]).toBe(false));

  window.dispatchEvent(
    new CustomEvent('results:refresh', { detail: { instanceId: 'instance-a' } }),
  );
  await Promise.resolve();
  expect(requests).toHaveLength(1);
  expect(harness.state).toEqual([history, '', false]);
  cleanup?.();
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
