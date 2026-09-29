import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useProfile } from '../src/client/features/profile/useProfile';
import type { Profile } from '../src/shared/profile';

const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  request: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (index >= harness.state.length) harness.state.push(initial);
    return [
      harness.state[index],
      (value: unknown) => {
        harness.state[index] =
          typeof value === 'function' ? value(harness.state[index]) : value;
      },
    ];
  },
}));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({ organization: { refresh: harness.refresh } }),
}));
vi.mock('../src/client/features/organization/useOrganization', () => ({
  organizationRequest: harness.request,
}));

function render() {
  harness.cursor = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: Reactを差し替えた状態保持ハーネスで再描画を再現する。
  return useProfile({ displayName: '元の名前', revision: 2 });
}
beforeEach(() => {
  harness.state = [];
  vi.clearAllMocks();
  harness.refresh.mockResolvedValue(true);
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

it('遅い保存応答で途中の新しい入力を消さず、次の保存は更新後の版を使う', async () => {
  let resolve!: (value: Profile) => void;
  harness.request.mockImplementationOnce(
    () =>
      new Promise<Profile>((done) => {
        resolve = done;
      }),
  );
  render().setName('ＡＢＣ');
  const saving = render().save();
  expect(render().busy).toBe(true);
  render().setName('さらに編集中');
  resolve({ displayName: 'ABC', revision: 3 });
  await saving;
  expect(render().name).toBe('さらに編集中');
  expect(render().busy).toBe(false);
  harness.request.mockResolvedValueOnce({ displayName: 'さらに編集中', revision: 4 });
  await render().save();
  expect(harness.request).toHaveBeenLastCalledWith('/api/organization/profile', {
    displayName: 'さらに編集中',
    revision: 3,
  });
});

it('保存失敗では入力と版を保持し、同じ内容で再試行できる', async () => {
  harness.request.mockRejectedValueOnce(new Error('通信に失敗しました'));
  render().setName('新しい名前');
  await render().save();
  expect(render().name).toBe('新しい名前');
  expect(render().error).toBe('通信に失敗しました');
  expect(render().busy).toBe(false);
  expect(harness.refresh).not.toHaveBeenCalled();
  harness.request.mockResolvedValueOnce({ displayName: '新しい名前', revision: 3 });
  await render().save();
  expect(harness.request).toHaveBeenLastCalledWith('/api/organization/profile', {
    displayName: '新しい名前',
    revision: 2,
  });
  expect(render().error).toBe('');
});
