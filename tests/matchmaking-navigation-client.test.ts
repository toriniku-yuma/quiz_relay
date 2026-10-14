import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MatchError } from '../src/client/features/matchmaking/api';
import { useMatchmaking } from '../src/client/features/matchmaking/useMatchmaking';
import { API_PATHS } from '../src/shared/api-paths';

const mocks = vi.hoisted(() => ({
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
    const index = mocks.cursor++;
    if (index >= mocks.slots.length) mocks.slots[index] = value;
    return [
      mocks.slots[index],
      (next: unknown) => {
        mocks.slots[index] = typeof next === 'function' ? next(mocks.slots[index]) : next;
      },
    ];
  },
  useRef: (value: unknown) => {
    const index = mocks.cursor++;
    if (index >= mocks.slots.length) mocks.slots[index] = { current: value };
    return mocks.slots[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => undefined | (() => void)) => mocks.effects.push(effect),
}));
vi.mock('../src/client/features/game/useGame', () => ({
  useGame: () => ({ ...mocks.game, attach: mocks.attach, leave: mocks.leave }),
}));
vi.mock('../src/client/features/rooms/api', async (original) => ({
  ...(await original<typeof import('../src/client/features/rooms/api')>()),
  playRequest: mocks.request,
}));
vi.mock('../src/client/features/matchmaking/api', async (original) => ({
  ...(await original<typeof import('../src/client/features/matchmaking/api')>()),
  matchRequest: mocks.request,
  resumeMatch: mocks.resume,
}));
beforeEach(() => {
  mocks.slots = [];
  mocks.cursor = 0;
  mocks.effects = [];
  mocks.game = {
    roomId: null,
    roomInstanceId: 'instance-a',
    snapshot: null,
    connection: 'open',
  };
  mocks.request.mockReset().mockResolvedValue({ ok: true });
  mocks.resume.mockReset().mockResolvedValue({ room: 'room-a' });
  mocks.attach.mockReset().mockImplementation((room: string, instanceId: string) => {
    mocks.game.roomId = room;
    mocks.game.roomInstanceId = instanceId;
    mocks.game.snapshot = null;
  });
  mocks.leave.mockReset().mockImplementation(() => {
    mocks.game.roomId = null;
    mocks.game.snapshot = null;
  });
});
afterEach(() => vi.restoreAllMocks());
function render(target = 'instance-a', mode: 'ranked' | 'casual' = 'ranked') {
  mocks.cursor = 0;
  mocks.effects = [];
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
    mocks.game.roomId = 'room-a';
    mocks.game.snapshot = { phase: 'WAITING' };
    const firstRules = { correctAnswersToWin: 7, mistakesToDisqualify: 3 };
    mocks.request.mockResolvedValueOnce({ playersPerMatch: 4, rules: firstRules });
    render('instance-a', mode);
    mocks.effects[0]();
    await settle();
    expect(render('instance-a', mode)).toMatchObject({
      players: 4,
      rules: firstRules,
      error: '',
    });

    mocks.request.mockRejectedValueOnce(new Error('Aの設定取得失敗'));
    render('instance-a', mode);
    mocks.effects[0]();
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
    mocks.request.mockResolvedValueOnce({ playersPerMatch: 3, rules: secondRules });
    render('instance-b', mode);
    mocks.effects[0]();
    await settle();
    expect(render('instance-b', mode)).toMatchObject({
      players: 3,
      rules: secondRules,
      error: '',
    });
    mocks.request.mockRejectedValueOnce(new Error('参加結果不明'));
    await render('instance-b', mode).join();
    mocks.request.mockResolvedValueOnce({ playersPerMatch: 3, rules: secondRules });
    render('instance-b', mode);
    mocks.effects[0]();
    await settle();
    expect(render('instance-b', mode)).toMatchObject({
      uncertain: true,
      error: '参加結果不明',
    });
    expect(mocks.game.roomId).toBe('room-a');
    expect(mocks.game.roomInstanceId).toBe('instance-a');
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.leave).not.toHaveBeenCalled();
  },
);

it('対象のない画面では設定を取得せず、古い設定応答も現在の閲覧先へ反映しない', async () => {
  const late = deferred<{ playersPerMatch: number }>();
  mocks.request.mockReturnValueOnce(late.promise);
  render('instance-a');
  const cleanup = mocks.effects[0]();
  cleanup?.();
  render('');
  mocks.effects[0]();
  expect(mocks.request).toHaveBeenCalledOnce();

  mocks.request.mockResolvedValueOnce({ playersPerMatch: 3 });
  render('instance-b');
  mocks.effects[0]();
  await settle();
  late.resolve({ playersPerMatch: 4 });
  await settle();
  expect(render('instance-b')).toMatchObject({ players: 3, error: '' });
  expect(render('instance-a')).toMatchObject({ players: null, error: '' });
  expect(mocks.leave).not.toHaveBeenCalled();
});

it.each(['ranked', 'casual'] as const)(
  '%sの閲覧先変更・再描画は待機・対戦を取り消さない',
  async (mode) => {
    mocks.game.roomId = 'room-a';
    for (const phase of ['WAITING', 'REVEALING', null]) {
      mocks.game.snapshot = phase ? { phase } : null;
      render('instance-a', mode);
      render('instance-b', mode);
      mocks.effects[2]();
      mocks.effects[3]();
      await settle();
      expect(mocks.request).not.toHaveBeenCalled();
      expect(mocks.leave).not.toHaveBeenCalled();
      expect(mocks.game.roomId).toBe('room-a');
      expect(mocks.game.roomInstanceId).toBe('instance-a');
    }
  },
);

it.each(['ranked', 'casual'] as const)(
  '%sの遅い参加応答も閲覧先変更後に元の要求先へ接続する',
  async (mode) => {
    const response = deferred<{ room: string }>();
    mocks.request.mockReturnValueOnce(response.promise);
    const joining = render('instance-a', mode).join();
    render('instance-b', mode);
    mocks.effects[3]();
    response.resolve({ room: 'late-a' });
    await joining;
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      mode === 'ranked' ? API_PATHS.matchJoin : API_PATHS.casualJoin,
      { operationId: expect.any(String) },
      'instance-a',
    );
    expect(mocks.attach).toHaveBeenCalledExactlyOnceWith('late-a', 'instance-a');
    expect(mocks.leave).not.toHaveBeenCalled();
  },
);

it('遅い初回復帰と手動復帰は閲覧先変更後も元の参加を保持する', async () => {
  const late = deferred<{ room: string }>();
  mocks.resume.mockReturnValueOnce(late.promise);
  render();
  const cleanup = mocks.effects[1]();
  render('instance-b');
  late.resolve({ room: 'room-a' });
  await settle();
  expect(mocks.attach).toHaveBeenCalledExactlyOnceWith('room-a', 'instance-a');
  expect(mocks.request).not.toHaveBeenCalled();
  const manual = render().resume();
  render('instance-b');
  await manual;
  expect(mocks.game.roomId).toBe('room-a');
  cleanup?.();
});

it('別タブの接続を切断時取消で巻き込まず、サーバーが待機なしと確定した時だけ解除する', async () => {
  mocks.game.roomId = 'room-a';
  mocks.game.snapshot = { phase: 'WAITING' };
  mocks.game.connection = 'closed';
  render();
  mocks.effects[2]();
  await settle();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.leave).not.toHaveBeenCalled();
  mocks.resume.mockRejectedValue(new MatchError('NO_ACTIVE_MATCH'));
  render();
  mocks.effects[2]();
  await settle();
  expect(mocks.leave).toHaveBeenCalledOnce();
});

it('本人の取消は応答不明の参加を操作IDで取り消し、遅い参加応答を無視する', async () => {
  const response = deferred<{ room: string }>();
  mocks.request.mockReturnValueOnce(response.promise);
  const joining = render().join();
  const body = mocks.request.mock.calls[0][1];
  render('instance-b').cancel();
  render('instance-b');
  const cleanup = mocks.effects[3]();
  await settle();
  response.resolve({ room: 'cancelled-a' });
  await joining;
  expect(mocks.request).toHaveBeenCalledWith(
    API_PATHS.matchCancel,
    { operationId: body.operationId },
    'instance-a',
  );
  expect(mocks.attach).not.toHaveBeenCalled();
  cleanup?.();
});

it('本人の取消の応答消失では対象を変えずに再試行する', async () => {
  vi.useFakeTimers();
  try {
    mocks.game.roomId = 'room-a';
    mocks.game.snapshot = { phase: 'WAITING' };
    mocks.request
      .mockRejectedValueOnce(new Error('join response lost'))
      .mockRejectedValueOnce(new Error('cancel response lost'))
      .mockResolvedValue({ ok: true });
    await render().join();
    render().cancel();
    render('instance-b');
    const cleanup = mocks.effects[3]();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.leave).not.toHaveBeenCalled();
    cleanup?.();
    render('instance-b');
    mocks.effects[3]();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.request.mock.calls[2]).toEqual(mocks.request.mock.calls[1]);
    expect(mocks.leave).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('本人の取消と開始が競合した場合は開始済み試合へ復帰する', async () => {
  mocks.game.roomId = 'room-a';
  mocks.game.snapshot = { phase: 'WAITING' };
  mocks.request.mockRejectedValueOnce(new Error('join response lost'));
  await render().join();
  mocks.request.mockRejectedValueOnce(new MatchError('MATCH_STARTED'));
  render().cancel();
  render('instance-b');
  const cleanup = mocks.effects[3]();
  await settle();
  expect(mocks.attach).toHaveBeenCalledExactlyOnceWith('room-a', 'instance-a');
  expect(mocks.leave).not.toHaveBeenCalled();
  cleanup?.();
});

it('古い手動復帰応答は新しい参加を上書きしない', async () => {
  mocks.game.roomId = 'room-a';
  const late = deferred<{ room: string }>();
  mocks.resume.mockReturnValueOnce(late.promise);
  const manual = render().resume();
  mocks.request.mockResolvedValueOnce({ room: 'room-b' });
  await render('instance-b').join();
  mocks.attach.mockClear();
  late.resolve({ room: 'room-a' });
  await manual;
  expect(mocks.game.roomId).toBe('room-b');
  expect(mocks.attach).not.toHaveBeenCalled();
});
