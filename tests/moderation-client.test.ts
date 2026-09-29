import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSanctionEditor } from '../src/client/features/moderation/useModeration';
import { OrganizationRequestError } from '../src/client/features/organization/useOrganization';

const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  request: vi.fn(),
  saved: vi.fn(),
}));
vi.mock('react', () => ({
  useEffect: vi.fn(),
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
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
vi.mock('../src/client/app/context', () => ({ useApp: vi.fn() }));
vi.mock('../src/client/features/organization/useOrganization', () => ({
  organizationRequest: harness.request,
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
  harness.cursor = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: Reactを差し替えた状態保持ハーネスで再描画する。
  return useSanctionEditor('instance', 'actor', harness.saved);
}
beforeEach(() => {
  harness.state = [];
  harness.request.mockReset();
  harness.saved.mockReset();
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
it('失敗後も確認内容・操作ID・理由を保持して同一要求を再送する', async () => {
  render().setKind('ban');
  render().setReason('検証理由');
  render().preview();
  const pending = render().pending;
  harness.request.mockRejectedValue(new Error('通信失敗'));
  await render().commit();
  await render().commit();
  expect(render().pending).toEqual(pending);
  expect(harness.request.mock.calls[0]).toEqual(harness.request.mock.calls[1]);
  expect(render().reason).toBe('検証理由');
  expect(harness.saved).not.toHaveBeenCalled();
  render().back();
  expect(render().pending).toBeNull();
  expect(render().reason).toBe('検証理由');
  expect(render().uncertain).toBe(true);
  render().edit(null);
  expect(render().reason).toBe('検証理由');
  render().preview();
  expect(render().pending).toEqual(pending);
  harness.request.mockResolvedValue({ ok: true });
  await render().commit();
  expect(harness.request.mock.calls[2]).toEqual(harness.request.mock.calls[0]);
  expect(render().uncertain).toBe(false);
  expect(harness.saved).toHaveBeenCalledOnce();
});
it('確定した入力エラーは編集を再開でき、サーバー障害は同じ要求を保持する', async () => {
  render().setKind('ban');
  render().setReason('検証');
  render().preview();
  harness.request.mockRejectedValue(new OrganizationRequestError('入力エラー', 400));
  await render().commit();
  expect(render().uncertain).toBe(false);
  render().back();
  render().preview();
  const pending = render().pending;
  harness.request.mockRejectedValue(new OrganizationRequestError('サーバー障害', 503));
  await render().commit();
  render().back();
  render().preview();
  expect(render().pending).toEqual(pending);
  expect(render().uncertain).toBe(true);
});
it('1分指定の確認は期限を固定し、戻っても指定値を維持する', () => {
  render().setKind('timeout');
  render().setReason('検証');
  render().setTiming('duration');
  render().setDuration('1');
  render().setUnit('1');
  render().preview();
  const pending = render().pending;
  expect(pending).not.toBeNull();
  expect(Date.parse(String(pending?.expiresAt)) - Number(pending?.preparedAt)).toBe(
    60000,
  );
  render().back();
  expect(render().duration).toBe('1');
  expect(render().unit).toBe('1');
});
