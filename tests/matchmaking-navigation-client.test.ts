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
vi.mock('../src/client/features/rooms/api', async (original) => ({
  ...(await original<typeof import('../src/client/features/rooms/api')>()),
  playRequest: h.request,
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
function render(target = 'instance-a', mode: 'ranked' | 'casual' = 'ranked') {
  h.cursor = 0;
  h.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: Hook state harness for delayed responses and navigation.
  return useMatchmaking('self', 'instance-a', mode, target);
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

it.each(['ranked', 'casual'] as const)(
  '%sの設定・エラーは閲覧先ごとに表示し、成功後も参加結果不明の情報を保持する',
  async (mode) => {
    h.game.roomId = 'room-a';
    h.game.snapshot = { phase: 'WAITING' };
    const firstRules = { correctAnswersToWin: 7, mistakesToDisqualify: 3 };
    h.request.mockResolvedValueOnce({ playersPerMatch: 4, rules: firstRules });
    render('instance-a', mode);
    h.effects[0]();
    await settle();
    expect(render('instance-a', mode)).toMatchObject({
      players: 4,
      rules: firstRules,
      error: '',
    });

    h.request.mockRejectedValueOnce(new Error('Aの設定取得失敗'));
    render('instance-a', mode);
    h.effects[0]();
    await settle();
    expect(render('instance-a', mode)).toMatchObject({
      players: null,
      rules: null,
      error: 'Aの設定取得失敗',
    });
    expect(render('instance-b', mode)).toMatchObject({
      players: null,
      rules: null,
      error: '',
    });

    const secondRules = { correctAnswersToWin: 5, mistakesToDisqualify: 2 };
    h.request.mockResolvedValueOnce({ playersPerMatch: 3, rules: secondRules });
    render('instance-b', mode);
    h.effects[0]();
    await settle();
    expect(render('instance-b', mode)).toMatchObject({
      players: 3,
      rules: secondRules,
      error: '',
    });
    h.request.mockRejectedValueOnce(new Error('参加結果不明'));
    await render('instance-b', mode).join('name');
    h.request.mockResolvedValueOnce({ playersPerMatch: 3, rules: secondRules });
    render('instance-b', mode);
    h.effects[0]();
    await settle();
    expect(render('instance-b', mode)).toMatchObject({
      uncertain: true,
      error: '参加結果不明',
    });
    expect(h.game.roomId).toBe('room-a');
    expect(h.game.roomInstanceId).toBe('instance-a');
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.leave).not.toHaveBeenCalled();
  },
);

it('対象のない画面では設定を取得せず、古い設定応答も現在の閲覧先へ反映しない', async () => {
  const late = deferred<{ playersPerMatch: number }>();
  h.request.mockReturnValueOnce(late.promise);
  render('instance-a');
  const cleanup = h.effects[0]();
  cleanup?.();
  render('');
  h.effects[0]();
  expect(h.request).toHaveBeenCalledOnce();

  h.request.mockResolvedValueOnce({ playersPerMatch: 3 });
  render('instance-b');
  h.effects[0]();
  await settle();
  late.resolve({ playersPerMatch: 4 });
  await settle();
  expect(render('instance-b')).toMatchObject({ players: 3, error: '' });
  expect(render('instance-a')).toMatchObject({ players: null, error: '' });
  expect(h.leave).not.toHaveBeenCalled();
});

it.each(['ranked', 'casual'] as const)(
  '%sの閲覧先変更・再描画は待機・対戦を取り消さない',
  async (mode) => {
    h.game.roomId = 'room-a';
    for (const phase of ['WAITING', 'REVEALING', null]) {
      h.game.snapshot = phase ? { phase } : null;
      render('instance-a', mode);
      render('instance-b', mode);
      h.effects[2]();
      h.effects[3]();
      await settle();
      expect(h.request).not.toHaveBeenCalled();
      expect(h.leave).not.toHaveBeenCalled();
      expect(h.game.roomId).toBe('room-a');
      expect(h.game.roomInstanceId).toBe('instance-a');
    }
  },
);

it.each(['ranked', 'casual'] as const)(
  '%sの遅い参加応答も閲覧先変更後に元の要求先へ接続する',
  async (mode) => {
    const response = deferred<{ room: string }>();
    h.request.mockReturnValueOnce(response.promise);
    const joining = render('instance-a', mode).join('name');
    render('instance-b', mode);
    h.effects[3]();
    response.resolve({ room: 'late-a' });
    await joining;
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      mode === 'ranked' ? API_PATHS.matchJoin : API_PATHS.casualJoin,
      expect.objectContaining({ name: 'name' }),
      'instance-a',
    );
    expect(h.attach).toHaveBeenCalledExactlyOnceWith('late-a', 'instance-a');
    expect(h.leave).not.toHaveBeenCalled();
  },
);

it('遅い初回復帰と手動復帰は閲覧先変更後も元の参加を保持する', async () => {
  const late = deferred<{ room: string }>();
  h.resume.mockReturnValueOnce(late.promise);
  render();
  const cleanup = h.effects[1]();
  render('instance-b');
  late.resolve({ room: 'room-a' });
  await settle();
  expect(h.attach).toHaveBeenCalledExactlyOnceWith('room-a', 'instance-a');
  expect(h.request).not.toHaveBeenCalled();
  const manual = render().resume();
  render('instance-b');
  await manual;
  expect(h.game.roomId).toBe('room-a');
  cleanup?.();
});

it('別タブの接続を切断時取消で巻き込まず、サーバーが待機なしと確定した時だけ解除する', async () => {
  h.game.roomId = 'room-a';
  h.game.snapshot = { phase: 'WAITING' };
  h.game.connection = 'closed';
  render();
  h.effects[2]();
  await settle();
  expect(h.request).not.toHaveBeenCalled();
  expect(h.leave).not.toHaveBeenCalled();
  h.resume.mockRejectedValue(new MatchError('NO_ACTIVE_MATCH'));
  render();
  h.effects[2]();
  await settle();
  expect(h.leave).toHaveBeenCalledOnce();
});

it('本人の取消は応答不明の参加を操作IDで取り消し、遅い参加応答を無視する', async () => {
  const response = deferred<{ room: string }>();
  h.request.mockReturnValueOnce(response.promise);
  const joining = render().join('name');
  const body = h.request.mock.calls[0][1];
  render('instance-b').cancel();
  render('instance-b');
  const cleanup = h.effects[3]();
  await settle();
  response.resolve({ room: 'cancelled-a' });
  await joining;
  expect(h.request).toHaveBeenCalledWith(
    API_PATHS.matchCancel,
    { operationId: body.operationId },
    'instance-a',
  );
  expect(h.attach).not.toHaveBeenCalled();
  cleanup?.();
});

it('本人の取消の応答消失では対象を変えずに再試行する', async () => {
  vi.useFakeTimers();
  try {
    h.game.roomId = 'room-a';
    h.game.snapshot = { phase: 'WAITING' };
    h.request
      .mockRejectedValueOnce(new Error('join response lost'))
      .mockRejectedValueOnce(new Error('cancel response lost'))
      .mockResolvedValue({ ok: true });
    await render().join('name');
    render().cancel();
    render('instance-b');
    const cleanup = h.effects[3]();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.leave).not.toHaveBeenCalled();
    cleanup?.();
    render('instance-b');
    h.effects[3]();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request.mock.calls[2]).toEqual(h.request.mock.calls[1]);
    expect(h.leave).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('本人の取消と開始が競合した場合は開始済み試合へ復帰する', async () => {
  h.game.roomId = 'room-a';
  h.game.snapshot = { phase: 'WAITING' };
  h.request.mockRejectedValueOnce(new Error('join response lost'));
  await render().join('name');
  h.request.mockRejectedValueOnce(new MatchError('MATCH_STARTED'));
  render().cancel();
  render('instance-b');
  const cleanup = h.effects[3]();
  await settle();
  expect(h.attach).toHaveBeenCalledExactlyOnceWith('room-a', 'instance-a');
  expect(h.leave).not.toHaveBeenCalled();
  cleanup?.();
});

it('古い手動復帰応答は新しい参加を上書きしない', async () => {
  h.game.roomId = 'room-a';
  const late = deferred<{ room: string }>();
  h.resume.mockReturnValueOnce(late.promise);
  const manual = render().resume();
  h.request.mockResolvedValueOnce({ room: 'room-b' });
  await render('instance-b').join('name');
  h.attach.mockClear();
  late.resolve({ room: 'room-a' });
  await manual;
  expect(h.game.roomId).toBe('room-b');
  expect(h.attach).not.toHaveBeenCalled();
});
