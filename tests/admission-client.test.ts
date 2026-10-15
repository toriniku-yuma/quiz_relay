import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAdmissionMutation } from '../src/client/features/matchmaking/useAdmissionMutation';
import { PlayRequestError } from '../src/client/features/rooms/api';
import { API_PATHS } from '../src/shared/api-paths';

const mocks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, request: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => {
    const index = mocks.cursor++;
    if (index >= mocks.slots.length) mocks.slots[index] = value;
    return [
      mocks.slots[index],
      (next: unknown) => {
        mocks.slots[index] = next;
      },
    ];
  },
  useRef: (value: unknown) => {
    const index = mocks.cursor++;
    if (index >= mocks.slots.length) mocks.slots[index] = { current: value };
    return mocks.slots[index];
  },
}));
vi.mock('../src/client/features/rooms/api', async (original) => ({
  ...(await original<typeof import('../src/client/features/rooms/api')>()),
  playRequest: mocks.request,
}));
beforeEach(() => {
  mocks.slots = [];
  mocks.cursor = 0;
  mocks.request.mockReset();
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
it('離脱を確認するまで新規参加を送らず、離脱失敗後も同じ選択を保つ', async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(
      new PlayRequestError(
        '参加中',
        409,
        'OTHER_INSTANCE_ACTIVE',
        'old-instance',
        'ranked',
        'old-room',
      ),
    )
    .mockResolvedValue({});
  const saved = vi.fn();
  const render = () => {
    mocks.cursor = 0;
    return useAdmissionMutation(API_PATHS.roomJoin, saved, send);
  };
  await render().submit({ room: 'new-room', instanceId: 'new-instance' });
  expect(render().conflict?.room).toBe('old-room');
  mocks.request.mockRejectedValueOnce(new Error('通信失敗'));
  await render().leaveAndJoin();
  expect(send).toHaveBeenCalledTimes(1);
  expect(render().conflict?.room).toBe('old-room');
  let release!: () => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const leaving = render().leaveAndJoin();
  expect(send).toHaveBeenCalledTimes(1);
  expect(mocks.request).toHaveBeenLastCalledWith(
    API_PATHS.matchCancel,
    { room: 'old-room', forfeit: true },
    'old-instance',
  );
  release();
  await leaving;
  expect(send).toHaveBeenCalledTimes(2);
  expect(saved).toHaveBeenCalledTimes(1);
  expect(render().conflict).toBeNull();
});
