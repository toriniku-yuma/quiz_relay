import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { isAppUrl } from '../src/client/app/navigation';
import {
  type QuestionPage,
  questionHref,
  questionListHref,
  questionListState,
  questionReturnHref,
} from '../src/client/features/questions/pages';
import QuestionManagementMenu from '../src/client/features/questions/QuestionManagementMenu';
import QuestionWorkspace from '../src/client/features/questions/QuestionWorkspace';
import {
  defaultQuestionSettings,
  emptyQuestion,
  type QuestionOverview,
} from '../src/shared/questions';

const model = vi.hoisted(() => ({
  data: null as QuestionOverview | null,
  error: '',
  loadFailed: false,
  stale: false,
}));
vi.mock('../src/client/features/questions/useQuestions', () => ({
  questionsRequest: vi.fn(),
  useQuestions: () => ({
    data: model.data,
    busy: false,
    error: model.error,
    loadFailed: model.loadFailed,
    stale: model.stale,
    message: '',
    mutate: vi.fn(),
    refresh: vi.fn(),
    setError: vi.fn(),
  }),
}));
beforeEach(() => {
  model.error = '';
  model.loadFailed = false;
  model.stale = false;
  model.data = {
    pagination: { page: 1, pageSize: 10, total: 2 },
    actorId: 'me',
    administrator: true,
    review: true,
    manageAuthors: true,
    qualified: true,
    settings: defaultQuestionSettings,
    settingsRevision: 1,
    submissions: ['me', 'other'].map((authorId) => ({
      id: authorId,
      authorId,
      seriesId: authorId,
      revision: 1,
      status: 'pending',
      input: { ...emptyQuestion(), text: `${authorId}の問題` },
      reason: '',
      publishedId: null,
      stopped: false,
      updatedAt: '',
    })),
    categories: [],
    tags: [],
    authors: [],
    notifications: [],
    categoryRequests: [],
    reviewCases: [],
    reports: [],
    difficulty: [],
  };
});
const render = (page: QuestionPage, selectedId: string | null = null) =>
  renderToStaticMarkup(
    createElement(QuestionWorkspace, { instanceId: 'instance', page, selectedId }),
  );

it('取得失敗時だけ再試行を表示し、保存・入力エラーでは表示しない', () => {
  expect(render('review')).not.toContain('再試行');
  expect(render('review')).not.toContain('再読み込み');
  model.error = '理由を入力してください。';
  expect(render('review')).not.toContain('再試行');
  model.loadFailed = true;
  model.error = '通信に失敗しました。';
  expect(render('review')).toContain('再試行');
  model.data = null;
  expect(render('mine')).toContain('再試行');
});

it('条件変更中と取得失敗時は古い結果・件数・ページ数を隠す', () => {
  for (const state of [
    { stale: true, loadFailed: false },
    { stale: false, loadFailed: true },
  ]) {
    Object.assign(model, state);
    const html = render('review');
    expect(html).not.toContain('meの問題');
    expect(html).not.toContain('全2件');
    expect(html).not.toContain('1 / 1ページ');
    expect(html).toContain('question-search');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>次へ<\/button>/);
  }
});

it('一覧条件と戻り先を保持し、外部URL・別インスタンスへの戻り先を受け入れない', () => {
  const state = {
    shared: 'shared' as const,
    sourceCategory: '33333333-3333-4333-8333-333333333333',
    peerOrigin: 'https://source.quiz-relay.workers.dev',
    sourceInstanceId: '22222222-2222-4222-8222-222222222222',
    band: 'all' as const,
    players: 'all' as const,
    sort: 'text',
    direction: 'asc' as const,
    query: '日本&山',
    status: 'pending',
    category: '11111111-1111-4111-8111-111111111111',
    page: 3,
    pageSize: 30,
  };
  const href = questionListHref('review', 'instance', state);
  expect(questionListState(href.split('?')[1])).toEqual(state);
  expect(questionReturnHref(`return=${encodeURIComponent(href)}`, 'current')).toBe(
    href.replace('instance=instance', 'instance=current'),
  );
  for (const value of [
    'https://evil.test/',
    '//evil.test/',
    '/\\evil.test/',
    '/game/',
    'http://[',
  ])
    expect(
      questionReturnHref(`return=${encodeURIComponent(value)}`, 'instance'),
    ).toBeUndefined();
  expect(questionListState('page=-1&size=20&status=invalid&category=invalid')).toEqual({
    shared: 'all',
    sourceCategory: '',
    peerOrigin: '',
    sourceInstanceId: '',
    band: 'all',
    players: 'all',
    sort: 'updatedAt',
    direction: 'desc',
    query: '',
    status: '',
    category: '',
    page: 1,
    pageSize: 10,
  });
  const pending = questionListHref('pending', 'instance', state);
  const detail = renderToStaticMarkup(
    createElement(QuestionWorkspace, {
      instanceId: 'instance',
      page: 'decision',
      selectedId: 'other',
      search: `return=${encodeURIComponent(pending)}`,
    }),
  );
  expect(detail).toContain(pending.replaceAll('&', '&amp;'));
  const list = renderToStaticMarkup(
    createElement(QuestionWorkspace, {
      instanceId: 'instance',
      page: 'review',
      selectedId: null,
      search: href.split('?')[1],
    }),
  );
  expect(list).toContain('value="日本&amp;山"');
  expect(list).toContain('<option value="30" selected="">30件</option>');
  expect(list).toContain(`return=${encodeURIComponent(href)}`);
});

it('初回取得中も検索と件数選択、新規作問の入力を表示し、データが必要な部分だけ待つ', () => {
  model.data = null;
  const list = render('mine');
  expect(list).toContain('question-search');
  expect(list).toContain('1ページの表示件数');
  expect(list).toContain('問題一覧を読み込んでいます。');
  expect(list).not.toContain('全0件');
  expect(list).toContain('JSON取込');
  const editor = render('new');
  expect(editor).toContain('question-text');
  expect(editor).toContain('カテゴリを読み込み中');
  expect(editor).toMatch(/<button[^>]*disabled=""[^>]*>下書きを保存<\/button>/);
  expect(render('settings')).not.toContain('投稿方式：');
});

it('作問は管理者でも本人分だけで、審査一覧と個別フォームを分ける', () => {
  expect(render('mine')).toContain('meの問題');
  expect(render('mine')).not.toContain('otherの問題');
  expect(render('mine')).not.toContain('review-reason');
  expect(render('review')).toContain('otherの問題');
  expect(render('review')).not.toContain('review-reason');
  expect(render('decision', 'other')).toContain('review-reason');
  expect(render('decision', 'other')).not.toContain('新しい問題を作る');
  expect(render('new')).not.toContain('author-reason');
  expect(render('qualification')).toContain('author-reason');
  expect(render('qualification')).not.toContain('category-name');
});

it('直接アクセスでも担当外の審査・管理ページを表示しない', () => {
  if (!model.data) throw new Error('fixture');
  Object.assign(model.data, {
    administrator: false,
    review: false,
    manageAuthors: false,
  });
  for (const page of ['review', 'decision', 'settings', 'authors', 'tags'] as const)
    expect(render(page, 'other')).toContain('権限がありません');
  model.data.manageAuthors = true;
  expect(render('authors')).not.toContain('権限がありません');
  expect(render('review')).toContain('権限がありません');
  expect(render('edit', 'other')).not.toContain('otherの問題');
});

it('問題リンクはIDを安全に保持し、既存の同一タブ移動を使う', () => {
  const current = new URL('https://quiz.example/game/');
  const url = new URL(questionHref('decision', 'instance&other', 'id#fragment'), current);
  expect(url.pathname).toBe('/question-review/decision/');
  expect(url.searchParams.get('instance')).toBe('instance&other');
  expect(url.searchParams.get('id')).toBe('id#fragment');
  expect(isAppUrl(url, current)).toBe(true);
  expect(isAppUrl(new URL('/questions/new/', current), current)).toBe(true);
  expect(isAppUrl(new URL('/question-management/', current), current)).toBe(true);
});

it('問題管理のメニューは担当権限で区分とリンクを絞る', () => {
  const menu = (administrator: boolean, review: boolean, manageAuthors: boolean) =>
    renderToStaticMarkup(
      createElement(QuestionManagementMenu, {
        instanceId: 'instance',
        permissions: { administrator, review, manageAuthors },
      }),
    );
  const admin = menu(true, false, false);
  for (const label of ['全問題', '分類・整理', 'カテゴリ管理', '作問者資格の管理'])
    expect(admin).toContain(label);
  expect(admin).not.toContain('<details');
  const reviewer = menu(false, true, false);
  expect(reviewer).toContain('全問題');
  expect(reviewer).not.toContain('難易度');
  expect(reviewer).not.toContain('作問者資格の管理');
  const authors = menu(false, false, true);
  expect(authors).toContain('作問者資格の管理');
  expect(authors).not.toContain('全問題');
  expect(authors).not.toContain('分類・整理');
  expect(menu(false, false, false)).toContain('権限がありません');
});

it('審査待ちは提出済みだけを表示し、全問題は状態にかかわらず表示する', () => {
  if (!model.data) throw new Error('fixture');
  model.data.submissions[0].status = 'approved';
  expect(render('pending')).toContain('otherの問題');
  expect(render('pending')).not.toContain('meの問題');
  expect(render('review')).toContain('meの問題');
  expect(render('review')).toContain('問題管理に戻る');
});

it('一覧は初期10件で10・30・100件を選べ、先頭と末尾の移動を制限する', () => {
  if (!model.data) throw new Error('fixture');
  model.data.pagination = { page: 1, pageSize: 10, total: 31 };
  const first = render('review');
  expect(first).toContain('<option value="10" selected="">10件</option>');
  expect(first).toContain('<option value="30">30件</option>');
  expect(first).toContain('<option value="100">100件</option>');
  expect(first).toContain('全31件中 1〜10件');
  expect(first).toMatch(/<button[^>]*disabled=""[^>]*>前へ<\/button>/);
  model.data.pagination.page = 4;
  const last = render('review');
  expect(last).toContain('全31件中 31〜31件');
  expect(last).toMatch(/<button[^>]*disabled=""[^>]*>次へ<\/button>/);
  model.data.pagination = { page: 1, pageSize: 10, total: 0 };
  expect(render('pending')).toContain('全0件');
});
