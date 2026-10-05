import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MatchError } from '../src/client/features/matchmaking/api';
import { useMatchmaking } from '../src/client/features/matchmaking/useMatchmaking';
import { API_PATHS } from '../src/shared/api-paths';

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => undefined | (() => void)>,
  request: vi.fn(),
  resume: vi.fn(),
  attach: vi.fn(),
  leave: vi.fn(),
  game: {
    roomId: null as string | null,
    roomInstanceId: 'instance-a',
    snapshot: null as null | { phase: string },
    connection: 'open',
  },
}));
vi.mock('react', () => ({
  useState: (value: unknown) => {
    const index = h.cursor++;
    if (index >= h.slots.length) h.slots[index] = value;
    return [
      h.slots[index],
      (next: unknown) => {
        h.slots[index] = typeof next === 'function' ? next(h.slots[index]) : next;
      },
    ];
  },
  useRef: (value: unknown) => {
    const index = h.cursor++;
    if (index >= h.slots.length) h.slots[index] = { current: value };
    return h.slots[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => undefined | (() => void)) => h.effects.push(effect),
}));
vi.mock('../src/client/features/game/useGame', () => ({
  useGame: () => ({ ...h.game, attach: h.attach, leave: h.leave }),
}));
vi.mock('../src/client/features/matchmaking/api', async (original) => ({
  ...(await original<typeof import('../src/client/features/matchmaking/api')>()),
  matchRequest: h.request,
  resumeMatch: h.resume,
}));
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
  h.game = {
    roomId: null,
    roomInstanceId: 'instance-a',
    snapshot: null,
    connection: 'open',
  };
  h.request.mockReset().mockResolvedValue({ ok: true });
  h.resume.mockReset().mockResolvedValue({ room: 'room-a' });
  h.attach.mockReset().mockImplementation((room: string, instanceId: string) => {
    h.game.roomId = room;
    h.game.roomInstanceId = instanceId;
    h.game.snapshot = null;
  });
  h.leave.mockReset().mockImplementation(() => {
    h.game.roomId = null;
    h.game.snapshot = null;
  });
});
afterEach(() => vi.restoreAllMocks());
function render(page = '/game/?instance=instance-a', target = 'instance-a') {
  h.cursor = 0;
  h.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: Hook state harness for delayed responses and navigation.
  return useMatchmaking('self', 'instance-a', 'ranked', target, page);
}
const settle = () => new Promise((done) => setTimeout(done, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
it('待機の画面移動はサーバー確認後に解除し、開始済みの画面移動では取消しない', async () => {
  h.game.roomId = 'room-a';
  h.game.snapshot = { phase: 'WAITING' };
  render();
  render('/history/?instance=instance-a');
  h.effects[2]();
  render('/history/?instance=instance-a');
  const cleanup = h.effects[4]();
  await settle();
  expect(h.request).toHaveBeenCalledExactlyOnceWith(
    API_PATHS.matchCancel,
    { room: 'room-a' },
    'instance-a',
  );
  expect(h.leave).toHaveBeenCalledOnce();
  cleanup?.();
  h.game.roomId = 'started';
  h.game.snapshot = { phase: 'REVEALING' };
  h.request.mockClear();
  h.leave.mockClear();
  render('/account/');
  h.effects[2]();
  render('/account/');
  h.effects[4]();
  await settle();
  expect(h.request).not.toHaveBeenCalled();
  expect(h.leave).not.toHaveBeenCalled();
});
it('別タブの接続を切断時取消で巻き込まず、サーバーが待機なしと確定した時だけ解除する', async () => {
  h.game.roomId = 'room-a';
  h.game.snapshot = { phase: 'WAITING' };
  h.game.connection = 'closed';
  render();
  h.effects[3]();
  await settle();
  expect(h.request).not.toHaveBeenCalled();
  expect(h.leave).not.toHaveBeenCalled();
  h.resume.mockRejectedValue(new MatchError('NO_ACTIVE_MATCH'));
  render();
  h.effects[3]();
  await settle();
  expect(h.leave).toHaveBeenCalledOnce();
});
it('応答不明の別インスタンス参加を操作IDで取消し、元の開始済み試合を保持する', async () => {
  h.game.roomId = 'started-a';
  h.game.snapshot = { phase: 'REVEALING' };
  const response = deferred<{ room: string }>();
  h.request.mockImplementation((path) =>
    path === API_PATHS.matchJoin ? response.promise : Promise.resolve({ ok: true }),
  );
  const joining = render('/game/?instance=instance-b', 'instance-b').join('name');
  const body = h.request.mock.calls[0][1];
  render('/account/', 'instance-b');
  h.effects[2]();
  render('/account/', 'instance-b');
  const cleanup = h.effects[4]();
  await settle();
  response.resolve({ room: 'late-b' });
  await joining;
  expect(h.request).toHaveBeenCalledWith(
    API_PATHS.matchCancel,
    { operationId: body.operationId },
    'instance-b',
  );
  expect(h.leave).not.toHaveBeenCalled();
  expect(h.attach).not.toHaveBeenCalled();
  expect(h.game.roomId).toBe('started-a');
  cleanup?.();
});
it('画面移動後に届く初回の待機復帰も取消し、既に開始していた場合は復帰を保持する', async () => {
  const response = deferred<{ room: string }>();
  h.resume.mockReturnValueOnce(response.promise);
  render();
  const restoreCleanup = h.effects[1]();
  render('/account/');
  h.effects[2]();
  response.resolve({ room: 'room-a' });
  await settle();
  render('/account/');
  h.effects[2]();
  h.request.mockRejectedValueOnce(new MatchError('MATCH_STARTED'));
  render('/account/');
  const cancelCleanup = h.effects[4]();
  await settle();
  expect(h.request).toHaveBeenCalledWith(
    API_PATHS.matchCancel,
    { room: 'room-a' },
    'instance-a',
  );
  expect(h.leave).not.toHaveBeenCalled();
  expect(h.attach).toHaveBeenCalledTimes(2);
  restoreCleanup?.();
  cancelCleanup?.();
});
it('取消の応答消失では対象を変えずに再試行する', async () => {
  vi.useFakeTimers();
  try {
    h.game.roomId = 'room-a';
    h.game.snapshot = { phase: 'WAITING' };
    h.request
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ ok: true });
    render();
    render('/account/');
    h.effects[2]();
    render('/account/');
    const cleanup = h.effects[4]();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.leave).not.toHaveBeenCalled();
    cleanup?.();
    render('/account/');
    h.effects[4]();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request.mock.calls[1]).toEqual(h.request.mock.calls[0]);
    expect(h.leave).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it.each(['resume', 'cancel'] as const)(
  '手動%sの遅い応答は画面移動後の新しい参加を上書きしない',
  async (action) => {
    h.game.roomId = 'room-a';
    h.game.snapshot = { phase: 'WAITING' };
    const late = deferred<{ room: string }>();
    if (action === 'resume') h.resume.mockReturnValueOnce(late.promise);
    else h.request.mockReturnValueOnce(late.promise);
    const manual = render()[action]();
    render('/game/?instance=instance-b', 'instance-b');
    h.effects[2]();
    render('/game/?instance=instance-b', 'instance-b');
    const cleanup = h.effects[4]();
    await settle();
    h.request.mockResolvedValueOnce({ room: 'room-b' });
    await render('/game/?instance=instance-b', 'instance-b').join('name');
    h.attach.mockClear();
    h.leave.mockClear();
    late.resolve({ room: 'room-a' });
    await manual;
    expect(h.game.roomId).toBe('room-b');
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.leave).not.toHaveBeenCalled();
    cleanup?.();
  },
);

it('別タブで参加先が変わった取消は確定して操作禁止を解除する', async () => {
  h.resume.mockRejectedValueOnce(new MatchError('NO_ACTIVE_MATCH'));
  render();
  h.effects[1]();
  await settle();
  h.game.roomId = 'room-a';
  h.game.snapshot = { phase: 'WAITING' };
  h.leave.mockClear();
  h.request.mockRejectedValueOnce(new MatchError('STALE_ROOM'));
  render('/account/');
  h.effects[2]();
  render('/account/');
  const cleanup = h.effects[4]();
  await settle();
  expect(render('/account/').busy).toBe(false);
  expect(h.leave).toHaveBeenCalledOnce();
  expect(h.request).toHaveBeenCalledTimes(1);
  h.request.mockResolvedValueOnce({ room: 'room-b' });
  await render('/game/?instance=instance-b', 'instance-b').join('name');
  expect(h.game.roomId).toBe('room-b');
  cleanup?.();
});
