import { afterEach, expect, it, vi } from 'vitest';
import { foreignReturnUrl } from '../src/client/features/federation/redirect';
import { useForeignLogin } from '../src/client/features/federation/useForeignLogin';
import type { useForeignParticipation } from '../src/client/features/federation/useForeignParticipation';
import { useParticipationAuthorization } from '../src/client/features/federation/useParticipationAuthorization';
import { API_PATHS } from '../src/shared/api-paths';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => {
    const index = hooks.cursor++;
    if (index >= hooks.slots.length) hooks.slots[index] = value;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = next;
      },
    ];
  },
  useRef: (value: unknown) => {
    const index = hooks.cursor++;
    if (index >= hooks.slots.length) hooks.slots[index] = { current: value };
    return hooks.slots[index];
  },
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown, dependencies: unknown[]) => {
    const index = hooks.cursor++,
      previous = hooks.slots[index] as
        | { value: unknown; dependencies: unknown[] }
        | undefined;
    if (
      !previous ||
      dependencies.some((value, index) => value !== previous.dependencies[index])
    )
      hooks.slots[index] = { value: create(), dependencies };
    return (hooks.slots[index] as { value: unknown }).value;
  },
  useEffect: (effect: () => (() => void) | undefined, dependencies: unknown[]) => {
    const index = hooks.cursor++,
      previous = hooks.slots[index] as
        | { cleanup?: () => void; dependencies: unknown[] }
        | undefined;
    if (
      !previous ||
      dependencies.some((value, index) => value !== previous.dependencies[index])
    )
      hooks.effects.push(() => {
        previous?.cleanup?.();
        hooks.slots[index] = { dependencies, cleanup: effect() };
      });
  },
}));
vi.mock('../src/client/features/auth/client', () => ({
  authToken: async () => 'verified',
}));
afterEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  vi.unstubAllGlobals();
});
const settle = () => new Promise((done) => setTimeout(done, 0));
it('URLの証明を除去した再描画で交換を中断せず、ログアウト後の再描画で再ログインしない', async () => {
  const home = 'https://home.quiz-relay.workers.dev',
    host = 'https://host.quiz-relay.workers.dev',
    instance = crypto.randomUUID(),
    source = crypto.randomUUID(),
    state = crypto.randomUUID(),
    target = {
      peerOrigin: home,
      sourceInstanceId: source,
      hostInstanceId: instance,
      mode: 'ranked' as const,
    },
    storage = new Map([
      [
        'quiz-relay-foreign-authorization',
        JSON.stringify({
          target,
          flow: 'login',
          state,
          operationId: crypto.randomUUID(),
          startedAt: Date.now(),
        }),
      ],
    ]);
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal(
    'location',
    new URL(foreignReturnUrl({ ...target, peerOrigin: host }, state, 'proof')),
  );
  vi.stubGlobal('history', {
    replaceState: (_state: unknown, _title: string, path: string) =>
      vi.stubGlobal('location', new URL(path, host)),
  });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('PopStateEvent', Event);
  let complete!: (response: Response) => void;
  const snapshot = {
    account: {
      homeOrigin: home,
      organizationId: source,
      sourceActorId: 'a'.repeat(64),
      name: '参加者',
      organizationName: '所属元',
      expiresAt: Date.now() + 60000,
    },
    organizationName: '開催先',
    instances: [{ id: instance, name: '対戦', ranked: true, casual: true, room: true }],
  };
  const request = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal('fetch', request);
  const participation = {
    exchange: vi.fn(),
    endSession: vi.fn(),
  } as unknown as ReturnType<typeof useForeignParticipation>;
  function render() {
    hooks.cursor = 0;
    hooks.effects = [];
    // biome-ignore lint/correctness/useHookAtTopLevel: URL変更によるhookの再描画を再現する。
    const model = useForeignLogin(true, false, new URL(location.href), participation);
    for (const effect of hooks.effects) effect();
    return model;
  }
  render();
  expect(new URL(location.href).hash).toBe('');
  render();
  complete(Response.json({ ok: true }));
  await settle();
  const model = render();
  expect(model.data).toEqual(snapshot);
  expect(model.checked).toBe(true);
  expect(model.busy).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
  expect(String(request.mock.calls[1][0])).toBe(
    `${host}${API_PATHS.foreignLoginSession}`,
  );
  await model.logout();
  expect(render().data).toBeNull();
  expect(new URL(location.href).searchParams.get('guest')).toBe('1');
  expect(request).toHaveBeenCalledTimes(3);
  expect(participation.endSession).toHaveBeenCalledOnce();
});

it('期限切れの参加要求には開催先へ戻る理由を示し、同じ要求を再送しない', async () => {
  const target = {
      peerOrigin: 'https://host.quiz-relay.workers.dev',
      sourceInstanceId: crypto.randomUUID(),
      hostInstanceId: crypto.randomUUID(),
      mode: 'ranked' as const,
    },
    state = crypto.randomUUID(),
    operationId = crypto.randomUUID(),
    automatic = { flow: 'participation' as const, ready: false, actor: 'verified' },
    request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 'STALE_REQUEST' }, { status: 409 }));
  vi.stubGlobal('fetch', request);
  function render() {
    hooks.cursor = 0;
    hooks.effects = [];
    // biome-ignore lint/correctness/useHookAtTopLevel: 参加要求への応答による再描画を再現する。
    return useParticipationAuthorization(target, state, operationId, automatic);
  }
  await render().authorize();
  const model = render();
  expect(model.expired).toBe(true);
  expect(model.error).toBe(
    'この参加要求は終了しました。開催先へ戻って、改めて参加してください。',
  );
  await model.authorize();
  expect(request).toHaveBeenCalledOnce();
  expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
    ...target,
    operationId,
  });
});
