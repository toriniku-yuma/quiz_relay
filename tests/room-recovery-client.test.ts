import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { connectGameSocket } from '../src/client/features/game/connection';
import { useGame } from '../src/client/features/game/useGame';
import RoomLobby from '../src/client/features/rooms/RoomLobby';
import { useRoom } from '../src/client/features/rooms/useRoom';
import { API_PATHS } from '../src/shared/api-paths';
import { newRoomSettings, type RoomView } from '../src/shared/rooms';

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
function room() {
  mocks.cursor = 0;
  mocks.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: 状態を保持し、描画前の遅延応答を再現する。
  return useRoom('user-a');
}
function game() {
  mocks.cursor = 0;
  mocks.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: 同じhookを再描画するハーネス。
  return useGame('formal', 'user-a', 'instance-a');
}
it('Bへ入室直後の旧AのHTTP・ゲーム接続・切替通知で、新参加を消さない', async () => {
  const view = deferred<{ room: RoomView }>(),
    child = deferred<{ room: string }>();
  mocks.request.mockImplementation((path: string) =>
    path === API_PATHS.roomGame ? child.promise : view.promise,
  );
  room().join('room-a', 'instance-a');
  const active = room();
  mocks.effects[3]();
  const callbacks = mocks.connect.mock.calls[0][1];
  callbacks.message(JSON.stringify({ type: 'lobby', room: roomView('room-a') }));
  room();
  mocks.effects[4]();
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
  const cleanup = mocks.effects[0]();
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
    JSON.parse(sessionStorage.getItem('quiz-relay-1c:user-a') ?? 'null').room,
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
function lobby(session: ReturnType<typeof useRoom>) {
  mocks.cursor = 0;
  return RoomLobby({ session });
}
function lobbySession(waiting = false) {
  let current = 'room-a';
  const session = {
    active: { id: 'room-a', instanceId: 'instance-room-a' },
    room: { ...roomView('room-a'), waiting },
    connection: 'open',
    error: '',
    game: { leave: vi.fn(), snapshot: { result: { id: 'result-a' } } },
    exit: { submit: vi.fn(), busy: false, uncertain: false, error: '' },
    refresh: vi.fn().mockResolvedValue(undefined),
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
