import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useForeignParticipation } from '../src/client/features/federation/useForeignParticipation';
import { API_PATHS } from '../src/shared/api-paths';
import type { ForeignSession } from '../src/shared/participation';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => undefined | (() => void)>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => {
    const index = hooks.cursor++;
    if (index >= hooks.slots.length)
      hooks.slots[index] = typeof value === 'function' ? value() : value;
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
  useEffect: (effect: () => undefined | (() => void)) => hooks.effects.push(effect),
}));

const storageKey = 'quiz-relay-foreign-reservation';
const saved = {
  reservationId: 'a9c997cf-26e3-4051-a99b-1d0401e48d4f',
  operationId: 'd7c997cf-26e3-4051-a99b-1d0401e48d4f',
  target: {
    peerOrigin: 'https://source.quiz-relay.workers.dev',
    sourceOrganizationId: '186b2b2a-0a7c-42bc-bef9-17fe8b3222d7',
    hostInstanceId: '4ed56d67-fd75-4d02-8f0a-64966df2e897',
    mode: 'ranked' as const,
  },
};
const recovered: ForeignSession = {
  ...saved,
  sourceOrganizationId: saved.target.sourceOrganizationId,
  actorId: 'foreign-actor',
  name: '参加者',
  instanceId: saved.target.hostInstanceId,
  instanceName: '開催先',
  homeOrigin: saved.target.peerOrigin,
  mode: 'ranked',
  room: 'waiting-room',
  expiresAt: Date.now() + 60000,
};
const request = vi.fn<typeof fetch>();
beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  request.mockReset();
  const storage = new Map([[storageKey, JSON.stringify(saved)]]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal('location', new URL('https://host.quiz-relay.workers.dev/participate/'));
  vi.stubGlobal('fetch', request);
});
afterEach(() => vi.unstubAllGlobals());
function render(ready: boolean) {
  hooks.cursor = 0;
  hooks.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: 認証確定前後のhook描画を再現する。
  return useForeignParticipation(ready);
}
const settle = () => new Promise((done) => setTimeout(done, 0));

it('認証確定による再マウント前には復帰を始めず、確定後の1回だけ要求する', async () => {
  request.mockResolvedValue(Response.json(recovered));
  render(false);
  expect(hooks.effects[0]()).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  expect(localStorage.getItem(storageKey)).not.toBeNull();

  hooks.slots = [];
  render(true);
  const cleanup = hooks.effects[0]();
  expect(request).toHaveBeenCalledTimes(1);
  expect(String(request.mock.calls[0][0])).toContain(API_PATHS.participationSession);
  expect(render(true).busy).toBe(true);
  await settle();
  expect(render(true).session).toMatchObject({ actorId: recovered.actorId });
  expect(render(true).busy).toBe(false);
  cleanup?.();
});

it('待機解除の409では理由を表示し、終了した復帰情報を消す', async () => {
  request.mockResolvedValue(
    Response.json({ code: 'STALE_RESERVATION' }, { status: 409 }),
  );
  render(true);
  const cleanup = hooks.effects[0]();
  await settle();
  const model = render(true);
  expect(model.error).toBe('この参加予約は終了しました。改めて参加してください。');
  expect(model.session).toBeNull();
  expect(model.busy).toBe(false);
  expect(localStorage.getItem(storageKey)).toBeNull();
  cleanup?.();
});

it('一時的な通信失敗では復帰情報を保持し、通信エラーを表示する', async () => {
  request.mockRejectedValue(new Error('通信を確認してください。'));
  render(true);
  const cleanup = hooks.effects[0]();
  await settle();
  expect(render(true).error).toBe('通信を確認してください。');
  expect(localStorage.getItem(storageKey)).not.toBeNull();
  cleanup?.();
});

it('別タブが新しい参加を保存した後に旧予約の409が届いても、新しい保存を消さない', async () => {
  let finish!: (value: Response) => void;
  request.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(true);
  const cleanup = hooks.effects[0]();
  const next = { ...saved, reservationId: crypto.randomUUID() };
  localStorage.setItem(storageKey, JSON.stringify(next));
  finish(Response.json({ code: 'STALE_RESERVATION' }, { status: 409 }));
  await settle();
  expect(JSON.parse(localStorage.getItem(storageKey) ?? 'null')).toEqual(next);
  cleanup?.();
});

it.each(
  [200, 401, 500].flatMap((status) =>
    [false, true].map((joinFirst) => ({ status, joinFirst })),
  ),
)(
  '旧取消の応答（$status）が遅れても、次の参加操作の状態を変更しない（参加完了=$joinFirst）',
  async ({ status, joinFirst }) => {
    request.mockResolvedValueOnce(Response.json(recovered));
    render(true);
    hooks.effects[0]();
    await settle();
    let finishCancel!: (value: Response) => void;
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCancel = resolve;
      }),
    );
    const cancel = render(true).cancel(false);
    render(true).endSession();
    let finishJoin!: (value: Response) => void;
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishJoin = resolve;
      }),
    );
    const join = render(true).join(saved.target);
    const next = { ...recovered, reservationId: crypto.randomUUID() };
    if (joinFirst) {
      finishJoin(Response.json(next));
      await join;
    }
    finishCancel(
      Response.json(
        { code: status === 401 ? 'SESSION_REQUIRED' : 'INTERNAL' },
        { status },
      ),
    );
    await cancel;
    expect(render(true).busy).toBe(!joinFirst);
    expect(render(true).error).toBe('');
    if (!joinFirst) {
      finishJoin(Response.json(next));
      await join;
    }
    expect(render(true).session).toEqual(next);
    expect(render(true).busy).toBe(false);
    expect(JSON.parse(localStorage.getItem(storageKey) ?? 'null').reservationId).toBe(
      next.reservationId,
    );
  },
);

it.each([200, 401])(
  '別タブの新しい参加情報を旧取消の応答（%i）で消さない',
  async (status) => {
    request.mockResolvedValueOnce(Response.json(recovered));
    render(true);
    hooks.effects[0]();
    await settle();
    let finish!: (value: Response) => void;
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const cancel = render(true).cancel(false);
    const next = { ...saved, reservationId: crypto.randomUUID() };
    localStorage.setItem(storageKey, JSON.stringify(next));
    finish(Response.json({ code: 'SESSION_REQUIRED' }, { status }));
    await cancel;
    expect(JSON.parse(localStorage.getItem(storageKey) ?? 'null')).toEqual(next);
    expect(render(true).session).toBeNull();
    expect(render(true).busy).toBe(false);
  },
);
