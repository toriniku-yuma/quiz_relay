import {
  type QuestionListQuery,
  questionPageSizes,
  statusLabels,
} from '../../../shared/questions';

export function questionListState(search: string) {
  const params = new URLSearchParams(search);
  const page = Number(params.get('page') ?? 1);
  const size = Number(params.get('size') ?? 10);
  const status = params.get('status') ?? '';
  const category = params.get('category') ?? '';
  return {
    query: (params.get('q') ?? '').slice(0, 150),
    status: ['', 'stopped', ...Object.keys(statusLabels)].includes(status) ? status : '',
    category: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      category,
    )
      ? category
      : '',
    page: Number.isSafeInteger(page) && page >= 1 && page <= 1000000 ? page : 1,
    pageSize: (questionPageSizes as readonly number[]).includes(size) ? size : 10,
  };
}
export function questionListHref(
  page: 'mine' | 'review' | 'pending',
  instance: string,
  state: Omit<QuestionListQuery, 'scope'>,
) {
  const params = new URLSearchParams({
    instance,
    page: String(state.page),
    size: String(state.pageSize),
  });
  if (state.query) params.set('q', state.query);
  if (state.status && page !== 'pending') params.set('status', state.status);
  if (state.category) params.set('category', state.category);
  return `${questionPages[page].path}?${params}`;
}
export function questionReturnHref(search: string, instance: string) {
  const value = new URLSearchParams(search).get('return');
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return undefined;
  const url = new URL(value, 'https://questions.invalid');
  if (url.origin !== 'https://questions.invalid') return undefined;
  const page = (['mine', 'review', 'pending'] as const).find(
    (page) => questionPages[page].path === url.pathname,
  );
  return page
    ? questionListHref(page, instance, questionListState(url.search))
    : undefined;
}

export const questionPages = {
  mine: { path: '/questions/', title: '作問' },
  new: { path: '/questions/new/', title: '新しい問題を作る' },
  edit: { path: '/questions/edit/', title: '問題の編集・提出' },
  import: { path: '/questions/import/', title: '問題のJSON取込' },
  qualification: { path: '/questions/qualification/', title: '作問者資格の申請' },
  categoryRequest: { path: '/questions/category-request/', title: 'カテゴリ変更の申請' },
  management: { path: '/question-management/', title: '問題管理' },
  review: { path: '/question-review/', title: '全問題' },
  pending: { path: '/question-review/pending/', title: '審査待ち' },
  decision: { path: '/question-review/decision/', title: '問題の審査・使用停止' },
  reports: { path: '/question-review/reports/', title: '通報・再審議' },
  categoryRequests: {
    path: '/question-review/category-requests/',
    title: 'カテゴリ変更申請の審査',
  },
  classify: { path: '/question-review/classify/', title: 'カテゴリの一括変更' },
  classificationJson: {
    path: '/question-review/classification-json/',
    title: '分類用JSON',
  },
  difficulty: { path: '/question-review/difficulty/', title: '難易度の変更' },
  tags: { path: '/question-review/tags/', title: 'タグ統合' },
  authors: { path: '/question-review/authors/', title: '作問者資格の管理' },
  categories: { path: '/question-review/categories/', title: 'カテゴリ管理' },
  settings: { path: '/question-review/settings/', title: '投稿設定' },
  selection: { path: '/question-review/selection/', title: '出題・再審議の設定' },
} as const;
export type QuestionPage = keyof typeof questionPages;
export const questionManagementGroups = [
  { title: '問題', pages: ['review', 'difficulty'] },
  {
    title: '分類・整理',
    pages: ['categories', 'classify', 'classificationJson', 'tags'],
  },
  { title: '作問者', pages: ['authors'] },
] as const;
export function canOpenQuestionPage(
  page: QuestionPage,
  permissions: { administrator: boolean; review: boolean; manageAuthors: boolean },
) {
  if (permissions.administrator) return true;
  if (page === 'management') return permissions.review || permissions.manageAuthors;
  if (page === 'authors') return permissions.manageAuthors;
  if (['categories', 'settings', 'selection', 'difficulty'].includes(page)) return false;
  return !questionPages[page].path.startsWith('/question-review/') || permissions.review;
}
export function questionHref(page: QuestionPage, instance: string, id?: string) {
  const query = new URLSearchParams({ instance });
  if (id) query.set('id', id);
  return `${questionPages[page].path}?${query}`;
}
export function questionPage(path: string): QuestionPage {
  return (
    (Object.keys(questionPages) as QuestionPage[]).find(
      (key) => questionPages[key].path === `${path.replace(/\/$/, '')}/`,
    ) ?? 'mine'
  );
}
