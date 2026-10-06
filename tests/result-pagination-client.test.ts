import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useResults } from '../src/client/features/results/useResults';
import { API_PATHS } from '../src/shared/api-paths';
import type { HistoryEntry, ResultsOverview, ResultsQuery } from '../src/shared/results';

const mocks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => undefined | (() => void)>,
  request: vi.fn(),
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
vi.mock('../src/client/features/rooms/api', () => ({ playRequest: mocks.request }));
beforeEach(() => {
  mocks.slots = [];
  mocks.cursor = 0;
  mocks.effects = [];
  mocks.request.mockReset();
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
function render(query: ResultsQuery = { section: 'history' }, guest = false) {
  mocks.cursor = 0;
  mocks.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: Hook state harness for paginated reads and late responses.
  return useResults('self', 'instance-a', query, guest);
}
function entry(id: string): HistoryEntry {
  return {
    resultId: id,
    finishedAt: '2026-10-01T00:00:00.000Z',
    reason: 'exhausted',
    winnerId: null,
    ratingDelta: 0,
    outcome: 'draw',
    players: [],
    kind: 'casual',
  };
}
const page = (
  ids: string[],
  nextCursor: ResultsOverview['nextCursor'] = null,
): ResultsOverview => ({ history: ids.map(entry), ranking: [], nextCursor });
it('追加取得失敗でも表示とcursorを保持し、同じ読取を再試行して重複を除く', async () => {
  const cursor = { finishedAt: '2026-10-01T00:00:00.000Z', resultId: 'a' };
  mocks.request
    .mockResolvedValueOnce(page(['a'], cursor))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(page(['a', 'b']));
  await render().refresh();
  await render().loadMore();
  expect(render().data?.history.map((row) => row.resultId)).toEqual(['a']);
  expect(render().error).not.toBe('');
  await render().retry();
  expect(mocks.request.mock.calls[1].slice(0, 3)).toEqual(
    mocks.request.mock.calls[2].slice(0, 3),
  );
  expect(mocks.request.mock.calls[1][1]).toEqual({ section: 'history', cursor });
  expect(render().data?.history.map((row) => row.resultId)).toEqual(['a', 'b']);
});
it('絞込先の描画後に届いた旧応答を無視し、ゲスト用APIで詳細を読む', async () => {
  let resolve!: (value: ResultsOverview) => void;
  mocks.request.mockReturnValueOnce(
    new Promise<ResultsOverview>((done) => {
      resolve = done;
    }),
  );
  const earlier = render().refresh();
  const nextQuery = { section: 'history' as const, kind: 'room' as const };
  expect(render(nextQuery).data).toBeNull();
  resolve(page(['old']));
  await earlier;
  expect(render(nextQuery).data).toBeNull();
  mocks.request.mockResolvedValue(page(['detail']));
  const detail = { section: 'history' as const, resultId: crypto.randomUUID() };
  await render(detail, true).refresh();
  expect(mocks.request).toHaveBeenLastCalledWith(
    API_PATHS.playResults,
    detail,
    'instance-a',
    expect.any(AbortSignal),
  );
  expect(render(detail, true).data?.history[0].resultId).toBe('detail');
});
