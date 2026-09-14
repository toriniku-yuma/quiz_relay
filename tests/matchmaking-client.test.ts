import { beforeEach, expect, it, vi } from 'vitest';
import { MatchError } from '../src/client/features/matchmaking/api';
import { useMatchmaking } from '../src/client/features/matchmaking/useMatchmaking';

// hookの復帰処理を通信結果ごとに実行。React描画自体はブラウザーで検証する。
const mocks = vi.hoisted(() => ({
  effects: [] as Array<() => () => void>,
  attach: vi.fn(),
  leave: vi.fn(),
  resume: vi.fn(),
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: (effect: () => () => void) => mocks.effects.push(effect),
}));
vi.mock('../src/client/features/game/useGame', () => ({
  useGame: () => ({ roomId: 'expired-room', attach: mocks.attach, leave: mocks.leave }),
}));
vi.mock('../src/client/features/matchmaking/api', async (original) => ({
  ...(await original<typeof import('../src/client/features/matchmaking/api')>()),
  matchRequest: vi.fn().mockResolvedValue({ playersPerMatch: 2 }),
  resumeMatch: mocks.resume,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects.length = 0;
});

it('clears the saved room only when the server confirms there is no active match', async () => {
  mocks.resume.mockRejectedValue(new MatchError('NO_ACTIVE_MATCH'));
  useMatchmaking('user-a');
  const cleanup = mocks.effects[0]();
  await vi.waitFor(() => expect(mocks.leave).toHaveBeenCalledOnce());
  expect(mocks.attach).not.toHaveBeenCalled();
  cleanup();
});
it('keeps recovery information when resume fails temporarily', async () => {
  mocks.resume.mockRejectedValue(new Error('network offline'));
  useMatchmaking('user-a');
  const cleanup = mocks.effects[0]();
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
  mocks.effects[0]()();
  reject(new MatchError('NO_ACTIVE_MATCH'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.leave).not.toHaveBeenCalled();
});
