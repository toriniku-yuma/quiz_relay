import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { connectGameSocket } from '../src/client/features/game/connection';
import { useGame } from '../src/client/features/game/useGame';
import { OrganizationRequestError } from '../src/client/features/organization/useOrganization';
import RoomLobby from '../src/client/features/rooms/RoomLobby';
import { useRoom } from '../src/client/features/rooms/useRoom';
import { API_PATHS } from '../src/shared/api-paths';
import { newRoomSettings, type RoomView } from '../src/shared/rooms';
import { snapshot } from '../src/worker/game/state';
import { resultFixture } from './fixtures/result';

const mocks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => undefined | (() => void)>,
  request: vi.fn(),
  connect: vi.fn<typeof connectGameSocket>(),
  navigate: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => {
    const i = mocks.cursor++;
    if (i >= mocks.slots.length)
      mocks.slots[i] = typeof value === 'function' ? value() : value;
    return [
      mocks.slots[i],
      (next: unknown) => {
        mocks.slots[i] = typeof next === 'function' ? next(mocks.slots[i]) : next;
      },
    ];
  },
  useRef: (value: unknown) => {
    const i = mocks.cursor++;
    if (i >= mocks.slots.length) mocks.slots[i] = { current: value };
    return mocks.slots[i];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => undefined | (() => void)) => mocks.effects.push(effect),
}));
vi.mock('../src/client/features/game/connection', () => ({
  connectGameSocket: mocks.connect,
}));
vi.mock('../src/client/features/rooms/api', () => ({ playRequest: mocks.request }));
vi.mock('../src/client/app/navigation', () => ({ navigate: mocks.navigate }));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({
    auth: { user: { id: 'user-a' } },
    organization: { data: { account: { actorId: 'actor-a' } } },
    setMatchStatus: vi.fn(),
  }),
}));
beforeEach(() => {
  mocks.slots = [];
  mocks.cursor = 0;
  mocks.effects = [];
  mocks.request.mockReset();
  mocks.connect.mockReset().mockReturnValue(vi.fn());
  mocks.navigate.mockReset();
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', new URL('https://quiz.test/rooms/'));
});
afterEach(() => vi.unstubAllGlobals());
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
function roomView(id: string): RoomView {
  return {
    id,
    instanceId: `instance-${id}`,
    settings: { ...newRoomSettings(false), name: id },
    revision: 1,
    password: false,
    hostId: 'actor-a',
    members: [
      {
        id: 'actor-a',
        name: '参加者',
        guest: false,
        ready: false,
        joinedAt: 0,
        connected: true,
      },
    ],
    closed: false,
    playing: true,
    matchRoom: `match-${id}`,
    waiting: false,
  };
}
function room(identity = 'user-a') {
  mocks.cursor = 0;
  mocks.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: 状態を保持し、描画前の遅延応答を再現する。
  return useRoom(identity);
}
function game() {
  mocks.cursor = 0;
  mocks.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: 同じhookを再描画するハーネス。
  return useGame('formal', 'user-a', 'instance-a');
}
it('ゲスト本人確認の完了後も保存済みの試合結果と参加先を復元する', () => {
  const matchId = crypto.randomUUID();
  const { state } = resultFixture();
  const saved = {
    room: { id: matchId, instanceId: 'instance-a' },
    snapshot: { ...snapshot(state), matchId },
  };
  sessionStorage.setItem('quiz-relay-match:room:guest-a', JSON.stringify(saved));
  sessionStorage.setItem(
    'quiz-relay-room:guest-a',
    JSON.stringify({ id: 'room-a', instanceId: 'instance-a' }),
  );
  room('');
  mocks.effects[0]();
  mocks.effects[2]();
  room('guest-a');
  mocks.effects[0]();
  mocks.effects[2]();
  const recovered = room('guest-a');
  expect(recovered.active?.id).toBe('room-a');
  expect(recovered.game.roomId).toBe(matchId);
  expect(recovered.game.snapshot).toEqual(saved.snapshot);
  expect(
    JSON.parse(sessionStorage.getItem('quiz-relay-match:room:guest-a') ?? 'null'),
  ).toEqual(saved);
});
it('ロビー再接続は現在の参加先と試合を保持し、古い接続の通知を無視する', async () => {
  mocks.request.mockResolvedValue({ room: roomView('room-a') });
  room().join('room-a', 'instance-a');
  room().game.attach('running-match');
  const before = room();
  const cleanup = mocks.effects[4]();
  await settle();
  const previous = mocks.connect.mock.calls.at(-1)?.[1];
  previous?.error('connection lost');
  before.reconnect();
  const after = room();
  expect(after.active).toBe(before.active);
  expect(after.game.roomId).toBe('running-match');
  expect(after.error).toBe('');
  cleanup?.();
  previous?.error('late error');
  expect(room().error).toBe('');
});
it('ロビー状態の受信後は古いHTTP応答で上書きせず、試合接続エラーも消さない', async () => {
  const initial = deferred<{ room: RoomView }>();
  mocks.request.mockImplementation((path: string) =>
    path === API_PATHS.roomGame
      ? Promise.reject(new OrganizationRequestError('game denied', 403))
      : initial.promise,
  );
  room().join('room-a', 'instance-a');
  room();
  const cleanup = mocks.effects[4]();
  const socket = mocks.connect.mock.calls.at(-1)?.[1];
  const current = { ...roomView('room-a'), revision: 5 };
  socket?.message(JSON.stringify({ type: 'lobby', room: current }));
  initial.resolve({ room: { ...roomView('room-a'), revision: 1 } });
  await settle();
  expect(room().room?.revision).toBe(5);
  const gameCleanup = mocks.effects[5]();
  await settle();
  socket?.message(JSON.stringify({ type: 'lobby', room: current }));
  expect(room().error).toBe('game denied');
  cleanup?.();
  gameCleanup?.();
});
it('ロビーの初期HTTP取得が失敗しても状態の受信でエラーを解除する', async () => {
  mocks.request.mockRejectedValue(new OrganizationRequestError('initial failure', 503));
  room().join('room-a', 'instance-a');
  room();
  const cleanup = mocks.effects[4]();
  await settle();
  expect(room().error).toBe('initial failure');
  mocks.connect.mock.calls
    .at(-1)?.[1]
    .message(JSON.stringify({ type: 'lobby', room: roomView('room-a') }));
  expect(room().error).toBe('');
  cleanup?.();
});
it('開始済み試合の接続情報取得が一時的に失敗しても、同じ試合へ接続する', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  let cleanup: undefined | (() => void);
  try {
    mocks.request.mockImplementation((path: string) => {
      if (path !== API_PATHS.roomGame)
        return Promise.resolve({ room: roomView('room-a') });
      attempts++;
      return attempts === 1
        ? Promise.reject(new OrganizationRequestError('temporary failure', 500))
        : Promise.resolve({ room: 'match-room-a' });
    });
    room().join('room-a', 'instance-a');
    room();
    mocks.effects[4]();
    await vi.advanceTimersByTimeAsync(0);
    room();
    cleanup = mocks.effects[5]();
    await vi.advanceTimersByTimeAsync(1500);
    expect(attempts).toBe(2);
    expect(room().game.roomId).toBe('match-room-a');
  } finally {
    cleanup?.();
    vi.useRealTimers();
  }
});
it.each([403, 500])(
  '試合の接続情報取得は拒否または再試行期限で止まる: %s',
  async (status) => {
    vi.useFakeTimers();
    let attempts = 0;
    let cleanup: undefined | (() => void);
    try {
      mocks.request.mockImplementation((path: string) => {
        if (path !== API_PATHS.roomGame)
          return Promise.resolve({ room: roomView('room-a') });
        attempts++;
        return Promise.reject(new OrganizationRequestError('request failed', status));
      });
      room().join('room-a', 'instance-a');
      room();
      mocks.effects[4]();
      await vi.advanceTimersByTimeAsync(0);
      room();
      cleanup = mocks.effects[5]();
      await vi.advanceTimersByTimeAsync(60000);
      expect(attempts).toBe(status === 403 ? 1 : 20);
      expect(room().game.roomId).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cleanup?.();
      vi.useRealTimers();
    }
  },
);
it('復旧期限を超えて届いた接続情報で試合へ移動しない', async () => {
  vi.useFakeTimers();
  const child = deferred<{ room: string }>();
  let cleanup: undefined | (() => void);
  try {
    mocks.request.mockImplementation((path: string) =>
      path === API_PATHS.roomGame
        ? child.promise
        : Promise.resolve({ room: roomView('room-a') }),
    );
    room().join('room-a', 'instance-a');
    room();
    mocks.effects[4]();
    await vi.advanceTimersByTimeAsync(0);
    room();
    cleanup = mocks.effects[5]();
    await vi.advanceTimersByTimeAsync(30000);
    child.resolve({ room: 'match-room-a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(room().game.roomId).toBeNull();
    expect(room().error).toContain('復旧できません');
  } finally {
    cleanup?.();
    vi.useRealTimers();
  }
});
it.each(['HTTP', 'WebSocket'])('%sで閉鎖を確認した部屋は再接続しない', async (source) => {
  const view = deferred<{ room: RoomView }>();
  mocks.request.mockReturnValue(view.promise);
  room().join('room-a', 'instance-a');
  room();
  mocks.effects[4]();
  const callbacks = mocks.connect.mock.calls[0][1];
  expect(callbacks.finished?.()).toBe(false);
  const closed = { ...roomView('room-a'), closed: true, playing: false, matchRoom: null };
  if (source === 'HTTP') {
    view.resolve({ room: closed });
    await settle();
  } else callbacks.message(JSON.stringify({ type: 'lobby', room: closed }));
  expect(callbacks.finished?.()).toBe(true);
  expect(room().room?.closed).toBe(true);
});
it.each(['ROOM_CLOSED', 'ROOM_NOT_FOUND'])(
  '終了した部屋の復帰情報を破棄する（%s）',
  async (code) => {
    mocks.request.mockRejectedValue({ code, message: '部屋は利用できません' });
    room().join('room-a', 'instance-a');
    room();
    mocks.effects[4]();
    await settle();
    expect(room().active).toBeNull();
    expect(sessionStorage.getItem('quiz-relay-room:user-a')).toBeNull();
  },
);
it('Bへ入室直後の旧AのHTTP・ゲーム接続・切替通知で、新参加を消さない', async () => {
  const view = deferred<{ room: RoomView }>(),
    child = deferred<{ room: string }>();
  mocks.request.mockImplementation((path: string) =>
    path === API_PATHS.roomGame ? child.promise : view.promise,
  );
  room().join('room-a', 'instance-a');
  const active = room();
  mocks.effects[4]();
  const callbacks = mocks.connect.mock.calls[0][1];
  callbacks.message(JSON.stringify({ type: 'lobby', room: roomView('room-a') }));
  room();
  mocks.effects[5]();
  const refresh = active.refresh();
  active.join('room-b', 'instance-b');
  callbacks.released?.();
  callbacks.error('旧接続のエラー');
  callbacks.status('stopped');
  expect(
    callbacks.message(JSON.stringify({ type: 'lobby', room: roomView('room-a') })),
  ).toBe(false);
  view.resolve({ room: roomView('room-a') });
  child.resolve({ room: 'old-match' });
  await refresh;
  await settle();
  const next = room();
  expect(next.active).toEqual({ id: 'room-b', instanceId: 'instance-b' });
  expect(next.room).toBeNull();
  expect(next.error).toBe('');
  expect(next.game.roomId).toBeNull();
  expect(JSON.parse(sessionStorage.getItem('quiz-relay-room:user-a') ?? 'null')).toEqual(
    next.active,
  );
});
it('旧対戦接続の遅い通知・状態で、新対戦の復帰情報を消さない', () => {
  game().attach('match-a', 'instance-a');
  const active = game();
  const cleanup = mocks.effects[1]();
  const callbacks = mocks.connect.mock.calls[0][1];
  active.attach('match-b', 'instance-b');
  callbacks.released?.();
  callbacks.error('旧接続のエラー');
  callbacks.status('stopped');
  expect(
    callbacks.message(JSON.stringify({ type: 'state', snapshot: { matchId: 'old' } })),
  ).toBe(false);
  expect(game().roomId).toBe('match-b');
  expect(game().error).toBe('');
  expect(
    JSON.parse(sessionStorage.getItem('quiz-relay-match:user-a') ?? 'null').room,
  ).toEqual({ id: 'match-b', instanceId: 'instance-b' });
  if (typeof cleanup === 'function') cleanup();
});
function button(
  node: unknown,
  label: string,
): { disabled?: boolean; onClick(): void } | undefined {
  if (Array.isArray(node)) return node.map((child) => button(child, label)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  const element = node as {
    props: { children?: unknown; disabled?: boolean; onClick(): void };
  };
  return element.props?.children === label
    ? element.props
    : button(element.props?.children, label);
}
function lobby(
  session: ReturnType<typeof useRoom>,
  foreign?: Parameters<typeof RoomLobby>[0]['foreign'],
) {
  mocks.cursor = 0;
  return RoomLobby({ session, foreign });
}
function lobbySession(waiting = false) {
  let current = 'room-a';
  const session = {
    request: mocks.request,
    active: { id: 'room-a', instanceId: 'instance-room-a' },
    room: { ...roomView('room-a'), waiting },
    connection: 'open',
    error: '',
    game: { leave: vi.fn(), snapshot: { matchId: 'match-a', result: {} } },
    exit: { submit: vi.fn(), busy: false, uncertain: false, error: '' },
    refresh: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    reconnect: vi.fn(),
    isCurrent: (id: unknown) => id === current,
  } as unknown as ReturnType<typeof useRoom>;
  return {
    session,
    switchRoom: () => {
      current = 'room-b';
      session.active = { id: current, instanceId: 'instance-room-b' };
      session.room = roomView(current);
    },
  };
}
it.each([false, true])(
  '初期状態未取得でも、停止したロビーに手動再接続できる（状態未取得:%s）',
  (missing) => {
    const { session } = lobbySession();
    session.connection = 'stopped';
    if (missing) session.room = null;
    const reconnect = button(lobby(session), 'ロビーに再接続');
    expect(reconnect).toBeDefined();
    reconnect?.onClick();
    expect(session.reconnect).toHaveBeenCalledOnce();
    expect(session.leave).not.toHaveBeenCalled();
    expect(session.game.leave).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  '閉じた部屋からの退出は拒否されるAPIを使わない（外部:%s）',
  (external) => {
    const { session } = lobbySession();
    session.room = {
      ...roomView('room-a'),
      closed: true,
      playing: false,
      matchRoom: null,
    };
    const onClosed = vi.fn();
    const foreign = external
      ? {
          actorId: 'actor-a',
          href: '/rooms/',
          homeHistory: '/history/',
          onEdit: vi.fn(),
          onReturn: vi.fn(),
          onClosed,
        }
      : undefined;
    button(lobby(session, foreign), '部屋から退出')?.onClick();
    expect(session.leave).toHaveBeenCalledOnce();
    expect(session.exit.submit).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(external ? 1 : 0);
  },
);
it('閉鎖が成功した部屋へ再取得せず、表示更新の失敗と扱わない', async () => {
  const { session } = lobbySession();
  mocks.request.mockResolvedValue({ ok: true });
  vi.mocked(session.refresh).mockRejectedValue(new Error('ROOM_CLOSED'));
  button(lobby(session), '部屋を閉じる')?.onClick();
  await settle();
  expect(mocks.request).toHaveBeenCalledWith(
    API_PATHS.roomMutate,
    expect.objectContaining({ action: 'close', room: 'room-a' }),
    'instance-room-a',
  );
  expect(session.refresh).not.toHaveBeenCalled();
  expect(JSON.stringify(lobby(session))).not.toContain('表示を更新できません');
});
it('途中入室で待機中の本人は、他人の対戦中も退出できる', () => {
  const { session } = lobbySession(true);
  session.game.snapshot = null;
  const exit = button(lobby(session), '部屋から退出');
  expect(exit?.disabled).toBe(false);
  exit?.onClick();
  expect(session.exit.submit).toHaveBeenCalledWith({
    room: 'room-a',
    instanceId: 'instance-room-a',
  });
});
it('応答不明のロビー操作をB画面で再試行しても、送り先と本文はAへ固定する', async () => {
  const { session, switchRoom } = lobbySession();
  mocks.request.mockRejectedValueOnce(new Error('response lost'));
  button(lobby(session), '同じ部屋のロビーへ戻る')?.onClick();
  await settle();
  const original = mocks.request.mock.calls[0];
  switchRoom();
  mocks.request.mockResolvedValue({ ok: true });
  button(lobby(session), '同じ操作で再試行')?.onClick();
  await settle();
  expect(mocks.request.mock.calls[1]).toEqual(original);
  expect(original[2]).toBe('instance-room-a');
  expect(session.refresh).not.toHaveBeenCalled();
  expect(session.game.leave).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});
it.each(['保存応答前', '表示更新中'])(
  'Aのロビー復帰の%sにBへ入室しても、Bから移動・離脱しない',
  async (when) => {
    const { session, switchRoom } = lobbySession();
    const response = deferred<unknown>(),
      refreshed = deferred<void>();
    mocks.request.mockReturnValue(response.promise);
    vi.mocked(session.refresh).mockReturnValue(refreshed.promise);
    button(lobby(session), '同じ部屋のロビーへ戻る')?.onClick();
    if (when === '保存応答前') switchRoom();
    response.resolve({ ok: true });
    await settle();
    if (when === '表示更新中') switchRoom();
    refreshed.resolve();
    await settle();
    expect(session.game.leave).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  },
);

it('D1の結果を復元し、古い対戦状態で上書きしない', async () => {
  const id = crypto.randomUUID();
  game().attach(id, 'instance-a');
  game();
  const { state } = resultFixture();
  if (!state.result) throw new Error('result');
  const final = {
    ...snapshot(state),
    matchId: id,
    result: { ...state.result, storage: 'confirmed' as const },
  };
  mocks.request.mockResolvedValue({
    actorId: 'a',
    history: [{ matchId: id, snapshot: final, parentRoomId: 'parent' }],
  });
  const cleanups = mocks.effects.map((effect) => effect());
  await settle();
  expect(game().snapshot).toEqual(final);
  expect(game().parentRoomId).toBe('parent');
  expect(
    mocks.connect.mock.calls[0][1].message(
      JSON.stringify({ type: 'state', snapshot: { matchId: id, phase: 'WAITING' } }),
    ),
  ).toBe(false);
  expect(mocks.request).toHaveBeenCalledWith(
    API_PATHS.playResults,
    { section: 'history', matchId: id },
    'instance-a',
    expect.any(AbortSignal),
  );
  for (const cleanup of cleanups) cleanup?.();
});
