import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTableSelection } from '../src/client/components/useTableSelection';
import { useInvestigation } from '../src/client/features/moderation/useInvestigation';
import { useModeration } from '../src/client/features/moderation/useModeration';
import { useQuestionOperation } from '../src/client/features/questions/useQuestionOperation';
import { useQuestions } from '../src/client/features/questions/useQuestions';

const mocks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  request: vi.fn(),
  fetch: vi.fn(),
  url: new URL('https://quiz.example/users/?instance=one'),
}));
vi.mock('react', () => ({
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
  useRef: (value: unknown) => {
    const i = mocks.cursor++;
    if (i >= mocks.slots.length) mocks.slots[i] = { current: value };
    return mocks.slots[i];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (callback: () => unknown) => {
    mocks.effects.push(callback);
  },
}));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({
    url: mocks.url,
    auth: { user: { id: 'admin' } },
    organization: { data: { account: {}, instances: [] } },
  }),
}));
vi.mock('../src/client/features/organization/useOrganization', () => ({
  organizationRequest: mocks.request,
  OrganizationRequestError: class extends Error {},
}));
vi.mock('../src/client/features/auth/client', () => ({
  authToken: async () => 'test',
}));
function draw<T>(fn: () => T) {
  mocks.cursor = 0;
  mocks.effects = [];
  return fn();
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  mocks.slots = [];
  mocks.request.mockReset();
  mocks.fetch.mockReset();
  mocks.url = new URL('https://quiz.example/users/?instance=one');
  vi.stubGlobal('fetch', mocks.fetch);
});
it('ユーザー一覧はソート中も旧行・旧方向を保持し、遅れた応答を捨てる', async () => {
  const hook = () => draw(() => useModeration());
  mocks.request.mockResolvedValueOnce({ users: ['old'] });
  await hook().refresh();
  mocks.url.searchParams.set('sort', 'name');
  mocks.url.searchParams.set('direction', 'asc');
  const first = deferred();
  mocks.request.mockReturnValueOnce(first.promise);
  const firstRefresh = hook().refresh();
  expect(hook().data?.users).toEqual(['old']);
  expect(hook().displaySorting?.sort).toBe('reports');
  mocks.url.searchParams.set('direction', 'desc');
  const second = deferred();
  mocks.request.mockReturnValueOnce(second.promise);
  const secondRefresh = hook().refresh();
  second.resolve({ users: ['new'] });
  await secondRefresh;
  first.resolve({ users: ['late'] });
  await firstRefresh;
  expect(hook().data?.users).toEqual(['new']);
  expect(hook().displaySorting?.direction).toBe('desc');
  mocks.url.searchParams.set('actor', 'other');
  expect(hook().data).toBeNull();
});
it('問題一覧はソート失敗でも表示を保持し、再試行で更新、検索変更では旧結果を隠す', async () => {
  let sort = 'updatedAt',
    query = '';
  const hook = () =>
    draw(() =>
      useQuestions('instance', true, {
        scope: 'all',
        page: 1,
        pageSize: 10,
        query,
        category: '',
        status: '',
        sort,
        direction: 'asc',
      }),
    );
  mocks.fetch.mockResolvedValueOnce(Response.json({ submissions: ['old'] }));
  await hook().refresh();
  sort = 'text';
  const pending = deferred();
  mocks.fetch.mockReturnValueOnce(pending.promise);
  const request = hook().refresh();
  expect(hook().retaining).toBe(true);
  expect(hook().data?.submissions).toEqual(['old']);
  expect(hook().stale).toBe(false);
  pending.reject(new Error('offline'));
  await request;
  expect(hook().stale).toBe(false);
  expect(hook().loadFailed).toBe(true);
  mocks.fetch.mockResolvedValueOnce(Response.json({ submissions: ['new'] }));
  await hook().refresh();
  expect(hook().data?.submissions).toEqual(['new']);
  expect(hook().displaySorting.sort).toBe('text');
  query = 'another';
  expect(hook().stale).toBe(true);
  expect(hook().retaining).toBe(false);
});
it('調査戦績はソート取得中も表を保持し、成功時にだけ行と方向を更新する', async () => {
  let actor = 'one';
  const hook = () => draw(() => useInvestigation('instance', actor));
  mocks.request.mockResolvedValueOnce({ rows: ['old'] });
  hook();
  mocks.effects[0]();
  await Promise.resolve();
  hook().sort({ sort: 'correct', direction: 'desc' });
  hook();
  const pending = deferred();
  mocks.request.mockReturnValueOnce(pending.promise);
  mocks.effects[0]();
  expect(hook().data?.rows).toEqual(['old']);
  expect(hook().displaySorting.sort).toBe('finishedAt');
  pending.resolve({ rows: ['new'] });
  await pending.promise;
  expect(hook().data?.rows).toEqual(['new']);
  expect(hook().displaySorting.sort).toBe('correct');
  actor = 'other';
  expect(hook().data).toBeNull();
});

it('選択は同じ一覧の再描画をまたぎ、条件を変えて元に戻しても復活しない', () => {
  const hook = (scope: string) => draw(() => useTableSelection<{ id: string }>(scope));
  hook('a').select([{ id: '1' }], true);
  hook('a').select([{ id: '2' }], true);
  expect(hook('a').rows.map((row) => row.id)).toEqual(['1', '2']);
  hook('a').select([{ id: '1' }], false);
  expect(hook('a').rows.map((row) => row.id)).toEqual(['2']);
  expect(hook('b').rows).toEqual([]);
  expect(hook('a').rows).toEqual([]);
});

it('問題操作の通信結果が不明なら入力を固定して同じID・内容で再送する', async () => {
  const saved = vi.fn().mockResolvedValue(undefined);
  const hook = () => draw(() => useQuestionOperation('instance', saved));
  const body = {
    operation: 'bulk',
    action: 'delete',
    requestId: 'same',
    changes: [{ id: 'one', revision: 1 }],
  };
  mocks.fetch.mockRejectedValueOnce(new Error('offline'));
  expect(await hook().submit(body)).toBe(false);
  expect(hook().uncertain).toBe(true);
  mocks.fetch.mockResolvedValueOnce(new Response('{}'));
  expect(await hook().submit({ operation: 'different' })).toBe(true);
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual(body);
  expect(hook().uncertain).toBe(false);
  expect(saved).toHaveBeenCalledOnce();
});
