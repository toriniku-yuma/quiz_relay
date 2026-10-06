import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Button from '../src/client/components/Button';
import ReasonAction from '../src/client/features/moderation/ReasonAction';
import UserPermissions from '../src/client/features/moderation/UserPermissions';
import { useUserActions } from '../src/client/features/moderation/useUserActions';

const mocks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  request: vi.fn(),
  saved: vi.fn(),
}));
vi.mock('react', () => ({
  useRef: (value: unknown) => {
    const i = mocks.cursor++;
    if (i >= mocks.slots.length) mocks.slots[i] = { current: value };
    return mocks.slots[i];
  },
  useState: (value: unknown) => {
    const i = mocks.cursor++;
    if (i >= mocks.slots.length) mocks.slots[i] = value;
    return [
      mocks.slots[i],
      (next: unknown) => {
        mocks.slots[i] = typeof next === 'function' ? next(mocks.slots[i]) : next;
      },
    ];
  },
}));
vi.mock('../src/client/features/organization/useOrganization', () => ({
  organizationRequest: mocks.request,
  OrganizationRequestError: class extends Error {},
}));
function render<T>(fn: () => T) {
  mocks.cursor = 0;
  return fn();
}
type Element = {
  type: unknown;
  props: {
    children?: unknown;
    onSubmit?: (event: { preventDefault: () => void }) => void;
    onClick?: () => void;
  };
};
function find(root: unknown, type: unknown): Element | undefined {
  if (Array.isArray(root)) return root.map((child) => find(child, type)).find(Boolean);
  if (!root || typeof root !== 'object' || !('props' in root)) return;
  const element = root as Element;
  return element.type === type ? element : find(element.props.children, type);
}
beforeEach(() => {
  mocks.slots = [];
  mocks.request.mockReset();
  mocks.saved.mockReset();
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
it('保存後の取得失敗を伝え、開き直すと古い詳細を再取得する', async () => {
  const hook = () => render(() => useUserActions('instance', 'actor', mocks.saved));
  mocks.request.mockResolvedValue({ sanctions: [{ revision: 1 }] });
  await hook().load();
  mocks.request.mockRejectedValue(new Error('DETAIL_FAILED'));
  await expect(hook().refresh()).rejects.toThrow();
  expect(hook().error).toBe('DETAIL_FAILED');
  mocks.request.mockResolvedValue({ sanctions: [{ revision: 2 }] });
  await hook().show('sanction');
  expect(hook().data?.sanctions[0].revision).toBe(2);
  expect(hook().error).toBe('');
});
it('一覧だけ更新されても権限の編集開始時の基準を保持する', async () => {
  const user = {
    actorId: 'actor',
    name: '検証',
    origin: '組織',
    administrator: false,
    permissions: [],
  };
  const draw = (permissions: ('questions' | 'users')[]) =>
    render(() =>
      UserPermissions({
        user: { ...user, permissions },
        instanceId: 'instance',
        open: true,
        onClose: vi.fn(),
        saved: mocks.saved,
      }),
    );
  draw([]);
  mocks.request.mockResolvedValue({ ok: true });
  find(draw(['questions']), 'form')?.props.onSubmit?.({ preventDefault: vi.fn() });
  await vi.waitFor(() => expect(mocks.saved).toHaveBeenCalledOnce());
  expect(mocks.request.mock.calls[0][1]).toMatchObject({ permissions: [], expected: '' });
});
it('申立の送信済み表示を固定せず、維持判定後は再申立ボタンを利用できる', async () => {
  const draw = (disabled = false) =>
    render(() =>
      ReasonAction({
        title: '異議を申し立てる',
        input: { action: 'appeal', id: 'ban' },
        disabled,
      }),
    );
  find(draw(), Button)?.props.onClick?.();
  mocks.request.mockResolvedValue({ ok: true });
  find(draw(), 'form')?.props.onSubmit?.({ preventDefault: vi.fn() });
  await vi.waitFor(() => expect(find(draw(), 'form')).toBeUndefined());
  draw(true);
  expect(find(draw(false), Button)?.props.children).toBe('異議を申し立てる');
});
