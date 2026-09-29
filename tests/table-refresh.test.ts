import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTableSelection } from '../src/client/components/useTableSelection';
import { useInvestigation } from '../src/client/features/moderation/useInvestigation';
import { useModeration } from '../src/client/features/moderation/useModeration';
import { useQuestionOperation } from '../src/client/features/questions/useQuestionOperation';
import { useQuestions } from '../src/client/features/questions/useQuestions';

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  request: vi.fn(),
  fetch: vi.fn(),
  url: new URL('https://quiz.example/users/?instance=one'),
}));
vi.mock('react', () => ({
  useState: (value: unknown) => {
    const i = h.cursor++;
    if (i >= h.slots.length) h.slots[i] = value;
    return [
      h.slots[i],
      (next: unknown) => {
        h.slots[i] = typeof next === 'function' ? next(h.slots[i]) : next;
      },
    ];
  },
  useRef: (value: unknown) => {
    const i = h.cursor++;
    if (i >= h.slots.length) h.slots[i] = { current: value };
    return h.slots[i];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (callback: () => unknown) => {
    h.effects.push(callback);
  },
}));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({
    url: h.url,
    auth: { user: { id: 'admin' } },
    organization: { data: { account: {}, instances: [] } },
  }),
}));
vi.mock('../src/client/features/organization/useOrganization', () => ({
  organizationRequest: h.request,
  OrganizationRequestError: class extends Error {},
}));
vi.mock('../src/client/features/auth/client', () => ({
  setupAuth: async () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'test' } } }) },
  }),
}));
function draw<T>(fn: () => T) {
  h.cursor = 0;
  h.effects = [];
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
  h.slots = [];
  h.request.mockReset();
  h.fetch.mockReset();
  h.url = new URL('https://quiz.example/users/?instance=one');
  vi.stubGlobal('fetch', h.fetch);
});
it('ユーザー一覧はソート中も旧行・旧方向を保持し、遅れた応答を捨てる', async () => {
  const hook = () => draw(() => useModeration());
  h.request.mockResolvedValueOnce({ users: ['old'] });
  await hook().refresh();
  h.url.searchParams.set('sort', 'name');
  h.url.searchParams.set('direction', 'asc');
  const first = deferred();
  h.request.mockReturnValueOnce(first.promise);
  const a = hook().refresh();
  expect(hook().data?.users).toEqual(['old']);
  expect(hook().displaySorting?.sort).toBe('reports');
  h.url.searchParams.set('direction', 'desc');
  const second = deferred();
  h.request.mockReturnValueOnce(second.promise);
  const b = hook().refresh();
  second.resolve({ users: ['new'] });
  await b;
  first.resolve({ users: ['late'] });
  await a;
  expect(hook().data?.users).toEqual(['new']);
  expect(hook().displaySorting?.direction).toBe('desc');
  h.url.searchParams.set('actor', 'other');
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
  h.fetch.mockResolvedValueOnce(Response.json({ submissions: ['old'] }));
  await hook().refresh();
  sort = 'text';
  const pending = deferred();
  h.fetch.mockReturnValueOnce(pending.promise);
  const request = hook().refresh();
  expect(hook().retaining).toBe(true);
  expect(hook().data?.submissions).toEqual(['old']);
  expect(hook().stale).toBe(false);
  pending.reject(new Error('offline'));
  await request;
  expect(hook().stale).toBe(false);
  expect(hook().loadFailed).toBe(true);
  h.fetch.mockResolvedValueOnce(Response.json({ submissions: ['new'] }));
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
  h.request.mockResolvedValueOnce({ rows: ['old'] });
  hook();
  h.effects[0]();
  await Promise.resolve();
  hook().sort({ sort: 'correct', direction: 'desc' });
  hook();
  const pending = deferred();
  h.request.mockReturnValueOnce(pending.promise);
  h.effects[0]();
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
  expect(hook('a').rows.map((r) => r.id)).toEqual(['1', '2']);
  hook('a').select([{ id: '1' }], false);
  expect(hook('a').rows.map((r) => r.id)).toEqual(['2']);
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
  h.fetch.mockRejectedValueOnce(new Error('offline'));
  expect(await hook().submit(body)).toBe(false);
  expect(hook().uncertain).toBe(true);
  h.fetch.mockResolvedValueOnce(new Response('{}'));
  expect(await hook().submit({ operation: 'different' })).toBe(true);
  expect(JSON.parse(h.fetch.mock.calls[1][1].body)).toEqual(body);
  expect(hook().uncertain).toBe(false);
  expect(saved).toHaveBeenCalledOnce();
});
