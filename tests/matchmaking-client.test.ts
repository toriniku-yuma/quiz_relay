import { beforeEach, expect, it, vi } from 'vitest';
import { MatchError } from '../src/client/features/matchmaking/api';
import { useMatchmaking } from '../src/client/features/matchmaking/useMatchmaking';

// hookの復帰処理を通信結果ごとに実行。React描画自体はブラウザーで検証する。
const mocks = vi.hoisted(() => ({
  effects: [] as Array<() => () => void>,
  attach: vi.fn(),
  leave: vi.fn(),
  resume: vi.fn(),
  request: vi.fn(),
}));
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => () => void) => mocks.effects.push(effect),
}));
vi.mock('../src/client/features/game/useGame', () => ({
  useGame: () => ({ roomId: 'expired-room', attach: mocks.attach, leave: mocks.leave }),
}));
vi.mock('../src/client/features/matchmaking/api', async (original) => ({
  ...(await original<typeof import('../src/client/features/matchmaking/api')>()),
  matchRequest: mocks.request,
  resumeMatch: mocks.resume,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects.length = 0;
  mocks.request.mockReset().mockResolvedValue({ playersPerMatch: 2 });
});

it('clears the saved room only when the server confirms there is no active match', async () => {
  mocks.resume.mockRejectedValue(new MatchError('NO_ACTIVE_MATCH'));
  useMatchmaking('user-a');
  const cleanup = mocks.effects[1]();
  await vi.waitFor(() => expect(mocks.leave).toHaveBeenCalledOnce());
  expect(mocks.attach).not.toHaveBeenCalled();
  cleanup();
});
it('keeps recovery information when resume fails temporarily', async () => {
  mocks.resume.mockRejectedValue(new Error('network offline'));
  useMatchmaking('user-a');
  const cleanup = mocks.effects[1]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.leave).not.toHaveBeenCalled();
  cleanup();
});
it('ignores a delayed no-match response after unmount', async () => {
  let reject!: (error: Error) => void;
  const response = new Promise<{ room: string }>((_resolve, rejectResponse) => {
    reject = rejectResponse;
  });
  mocks.resume.mockReturnValue(response);
  useMatchmaking('user-a');
  mocks.effects[1]()();
  reject(new MatchError('NO_ACTIVE_MATCH'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.leave).not.toHaveBeenCalled();
});
it('keeps a new match when an earlier resume arrives late', async () => {
  let resolve!: (value: { room: string }) => void;
  mocks.resume.mockReturnValue(
    new Promise<{ room: string }>((done) => {
      resolve = done;
    }),
  );
  mocks.request.mockImplementation(async (path: string) =>
    path.endsWith('/join') ? { room: 'new-room' } : { playersPerMatch: 2 },
  );
  const match = useMatchmaking('user-a');
  const cleanup = mocks.effects[1]();
  await match.join('user-a');
  resolve({ room: 'old-room' });
  await new Promise((done) => setTimeout(done, 0));
  expect(mocks.attach).toHaveBeenCalledExactlyOnceWith('new-room', '');
  cleanup();
});
it('ignores an earlier no-match response after a successful cancellation', async () => {
  let reject!: (error: Error) => void;
  mocks.resume.mockReturnValue(
    new Promise<{ room: string }>((_resolve, fail) => {
      reject = fail;
    }),
  );
  const match = useMatchmaking('user-a');
  const cleanup = mocks.effects[1]();
  await match.cancel();
  reject(new MatchError('NO_ACTIVE_MATCH'));
  await new Promise((done) => setTimeout(done, 0));
  expect(mocks.leave).toHaveBeenCalledOnce();
  expect(mocks.attach).not.toHaveBeenCalled();
  cleanup();
});
it('参加結果が不明なら操作ID・名前・参加先を固定して再試行する', async () => {
  mocks.request
    .mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce({ room: 'confirmed' });
  const match = useMatchmaking('user-a', 'old-instance', 'ranked', 'new-instance');
  await match.join('original');
  await match.join('changed');
  expect(mocks.request.mock.calls[1]).toEqual(mocks.request.mock.calls[0]);
  expect(mocks.request.mock.calls[0][1]).toMatchObject({
    name: 'original',
    operationId: expect.any(String),
  });
  expect(mocks.request.mock.calls[0][2]).toBe('new-instance');
  expect(mocks.attach).toHaveBeenCalledWith('confirmed', 'new-instance');
});
it('同じモードの別インスタンスを復帰先として提示し、他モードは解除しない', async () => {
  mocks.resume
    .mockRejectedValueOnce(
      new MatchError('OTHER_INSTANCE_ACTIVE', 'instance-b', 409, 'ranked'),
    )
    .mockResolvedValueOnce({ room: 'room-b' });
  useMatchmaking('user-a', 'instance-a');
  const cleanup = mocks.effects[1]();
  await vi.waitFor(() =>
    expect(mocks.attach).toHaveBeenCalledWith('room-b', 'instance-b'),
  );
  expect(mocks.resume).toHaveBeenLastCalledWith('instance-b');
  cleanup();
  expect(mocks.leave).not.toHaveBeenCalled();
});
