import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMutation } from '../src/client/features/moderation/useMutation';
import { OrganizationRequestError } from '../src/client/features/organization/useOrganization';

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  request: vi.fn(),
  saved: vi.fn(),
}));
vi.mock('react', () => ({
  useRef: (value: unknown) => {
    const i = h.cursor++;
    if (i >= h.slots.length) h.slots[i] = { current: value };
    return h.slots[i];
  },
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
}));
vi.mock('../src/client/features/organization/useOrganization', () => ({
  organizationRequest: h.request,
  OrganizationRequestError: class extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
function render() {
  h.cursor = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: Hook state harness.
  return useMutation('/workflow', h.saved);
}
beforeEach(() => {
  h.slots = [];
  h.request.mockReset();
  h.saved.mockReset();
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
it('閉じて再描画しても応答不明の要求を固定し、別の入力を送信しない', async () => {
  h.request.mockRejectedValue(new Error('接続失敗'));
  await render().submit({ action: 'appeal', reason: '元の内容' });
  expect(render().uncertain).toBe(true);
  h.request.mockResolvedValue({ ok: true });
  await render().submit({ action: 'report', reason: '変更された内容' });
  expect(h.request.mock.calls[1][1]).toEqual(h.request.mock.calls[0][1]);
  expect(render().uncertain).toBe(false);
  expect(h.saved).toHaveBeenCalledOnce();
});
it('二重クリックを抑止し、保存後の表示取得失敗を送信失敗と混同しない', async () => {
  let finish: (v: unknown) => void = () => {};
  h.request.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  h.saved.mockRejectedValue(new Error('一覧失敗'));
  const sending = render().submit({ action: 'resolveReports' });
  await render().submit({ action: 'resolveReports' });
  expect(h.request).toHaveBeenCalledOnce();
  finish({ ok: true });
  await sending;
  expect(render().uncertain).toBe(false);
  expect(render().error).toContain('保存しましたが');
});
it('確定した拒否では修正可能になり、次の送信を別操作として扱う', async () => {
  h.request.mockRejectedValue(new OrganizationRequestError('理由を入力', 400));
  await render().submit({ reason: '' });
  expect(render().uncertain).toBe(false);
  h.request.mockResolvedValue({ ok: true });
  await render().submit({ reason: '修正' });
  expect(h.request.mock.calls[1][1].reason).toBe('修正');
  expect(h.request.mock.calls[1][1].operationId).not.toBe(
    h.request.mock.calls[0][1].operationId,
  );
});
