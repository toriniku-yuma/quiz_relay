import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RoomWorkspace from '../src/client/features/rooms/RoomWorkspace';
import { useGuest } from '../src/client/features/rooms/useGuest';
import { API_PATHS } from '../src/shared/api-paths';
import { newRoomSettings } from '../src/shared/rooms';

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => (() => void) | undefined>,
  request: vi.fn(),
  join: vi.fn(),
  navigate: vi.fn(),
  exit: vi.fn(),
  active: null as null | { id: string; instanceId: string },
  roomView: null as null | {
    id: string;
    playing: boolean;
    waiting?: boolean;
    matchRoom?: string;
  },
  restored: false,
  url: new URL('https://quiz.test/rooms/?instance=instance-a&room=room-a'),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => {
    const i = h.cursor++;
    if (i >= h.slots.length) h.slots[i] = value;
    return [
      h.slots[i],
      (next: unknown) => {
        h.slots[i] = next;
      },
    ];
  },
  useRef: (value: unknown) => {
    const i = h.cursor++;
    if (i >= h.slots.length) h.slots[i] = { current: value };
    return h.slots[i];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | undefined) => h.effects.push(effect),
}));
vi.mock('../src/client/features/rooms/api', () => ({ playRequest: h.request }));
vi.mock('../src/client/app/navigation', () => ({ navigate: h.navigate }));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({ auth: { user: { id: 'user-a' } }, organization: {}, url: h.url }),
}));
vi.mock('../src/client/features/rooms/useRoom', () => ({
  useRoom: () => ({
    active: h.active,
    room: h.roomView,
    restored: h.restored,
    isCurrent: (id: unknown) => (h.active?.id ?? null) === id,
    join: h.join,
    exit: { submit: h.exit },
  }),
}));
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
  h.request.mockReset();
  h.join.mockReset();
  h.navigate.mockReset();
  h.exit.mockReset().mockResolvedValue({ ok: true });
  h.active = null;
  h.roomView = null;
  h.restored = false;
  h.url = new URL('https://quiz.test/rooms/?instance=instance-a&room=room-a');
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
function guest() {
  h.cursor = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: Hook state harness.
  return useGuest(true);
}
const settle = () => new Promise((done) => setTimeout(done, 0));
it('登録後のゲスト名・本人IDを遅い初回応答で消さない', async () => {
  let finish!: (value: { name: null }) => void;
  h.request.mockReturnValueOnce(
    new Promise((done) => {
      finish = done;
    }),
  );
  guest();
  const cleanup = h.effects[0]();
  h.request.mockResolvedValue({ id: 'guest-a', name: '参加者' });
  await guest().refresh();
  finish({ name: null });
  await settle();
  expect(guest().data).toEqual({ id: 'guest-a', name: '参加者' });
  cleanup?.();
});
it('後発の失敗を古いゲスト応答で取り消さず、解除後の応答も無視する', async () => {
  let finish!: (value: { name: null }) => void;
  h.request.mockReturnValueOnce(
    new Promise((done) => {
      finish = done;
    }),
  );
  guest();
  const cleanup = h.effects[0]();
  h.request.mockRejectedValue(new Error('後発の失敗'));
  await guest().refresh();
  cleanup?.();
  finish({ name: null });
  await settle();
  expect(guest().data).toBeNull();
  expect(guest().error).toBe('後発の失敗');
});
function submit(
  node: unknown,
): ((event: { preventDefault(): void }) => void) | undefined {
  if (Array.isArray(node)) return node.map(submit).find(Boolean);
  if (!node || typeof node !== 'object') return;
  const element = node as {
    type: unknown;
    props: { children?: unknown; onSubmit?: (event: { preventDefault(): void }) => void };
  };
  return element.type === 'form'
    ? element.props.onSubmit
    : submit(element.props?.children);
}
function room() {
  h.cursor = 0;
  return RoomWorkspace();
}
it.each(['/profile/', '/rooms/?instance=instance-a'])(
  '部屋ロビーから%sへ移動すると元の部屋だけを自動退室する',
  (next) => {
    h.active = { id: 'room-a', instanceId: 'instance-a' };
    h.roomView = { id: 'room-a', playing: false };
    room();
    h.effects[2]();
    h.effects = [];
    h.url = new URL(`https://quiz.test${next}`);
    room();
    h.effects[2]();
    expect(h.exit).toHaveBeenCalledExactlyOnceWith({
      room: 'room-a',
      instanceId: 'instance-a',
      force: true,
    });
  },
);
it.each(['edit', 'game'])('同じ部屋の%s画面への移動では参加を保持する', (view) => {
  h.active = { id: 'room-a', instanceId: 'instance-a' };
  h.roomView = { id: 'room-a', playing: false };
  room();
  h.effects[2]();
  h.effects = [];
  h.url.searchParams.set('view', view);
  room();
  h.effects[2]();
  expect(h.exit).not.toHaveBeenCalled();
});
it('開始した本人は対戦専用ページへ移り、途中入室者はロビーに留まる', () => {
  h.active = { id: 'room-a', instanceId: 'instance-a' };
  h.roomView = { id: 'room-a', playing: true, matchRoom: 'match-a' };
  room();
  h.effects[3]();
  expect(h.navigate).toHaveBeenCalledExactlyOnceWith(
    '/rooms/?instance=instance-a&room=room-a&view=game',
  );
  h.navigate.mockClear();
  h.effects = [];
  h.roomView.waiting = true;
  room();
  h.effects[3]();
  expect(h.navigate).not.toHaveBeenCalled();
});
it('部屋状態を確認する前の画面移動は、試合中の参加をロビー退出扱いにしない', () => {
  h.active = { id: 'room-a', instanceId: 'instance-a' };
  room();
  h.effects[2]();
  h.effects = [];
  h.url = new URL('https://quiz.test/profile/');
  room();
  h.effects[2]();
  expect(h.exit).not.toHaveBeenCalled();
});
it('新しい部屋に入った直後の旧部屋状態では、対戦画面へ移動しない', () => {
  h.active = { id: 'room-b', instanceId: 'instance-a' };
  h.roomView = { id: 'room-a', playing: true, matchRoom: 'match-a' };
  h.url.searchParams.set('room', 'room-b');
  room();
  h.effects[3]();
  expect(h.navigate).not.toHaveBeenCalled();
});
it('Aの遅い復帰確認で、成立済みのB参加を上書きしない', async () => {
  let finish!: (value: unknown) => void;
  h.request.mockImplementation((path: string) =>
    path === API_PATHS.roomView
      ? new Promise((done) => {
          finish = done;
        })
      : Promise.resolve({ room: { settings: newRoomSettings(false) } }),
  );
  room();
  h.effects[1]();
  h.active = { id: 'room-b', instanceId: 'instance-b' };
  finish({ room: {} });
  await settle();
  expect(h.join).not.toHaveBeenCalled();
  expect(h.active.id).toBe('room-b');
});
it.each(['instance-a', 'instance-b'])(
  '応答不明のA参加をB画面（%s）で再試行しても、要求先と復帰先をAへ固定する',
  async (nextInstance) => {
    h.request.mockImplementation(async (path: string) => {
      if (path === API_PATHS.roomInfo)
        return { room: { settings: newRoomSettings(false), instanceId: 'instance-a' } };
      throw new Error('通信結果不明');
    });
    room();
    h.effects[1]();
    await settle();
    const enter = submit(room());
    if (!enter) throw new Error('参加フォーム');
    enter({ preventDefault() {} });
    await settle();
    const original = h.request.mock.calls.find(([path]) => path === API_PATHS.roomJoin);
    if (!original) throw new Error('参加要求');
    h.url = new URL(`https://quiz.test/rooms/?instance=${nextInstance}&room=room-b`);
    h.request.mockResolvedValue({ ok: true });
    const retry = submit(room());
    if (!retry) throw new Error('再試行フォーム');
    retry({ preventDefault() {} });
    await settle();
    const attempts = h.request.mock.calls.filter(([path]) => path === API_PATHS.roomJoin);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(original);
    expect(h.join).toHaveBeenCalledExactlyOnceWith('room-a', 'instance-a');
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith(
      '/rooms/?instance=instance-a&room=room-a',
    );
  },
);
