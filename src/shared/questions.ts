export const graphemes = (text: string) =>
  Array.from(
    new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(
      text.normalize('NFKC').trim(),
    ),
    ({ segment }) => segment,
  );

export const submissionModes = ['admin', 'qualified', 'review', 'open'] as const;
export type SubmissionMode = (typeof submissionModes)[number];
export type QuestionInput = {
  text: string;
  displayAnswer: string;
  readings: string[];
  traps: { answer: string; reading: string }[];
  explanation: string;
  evidence: string;
  source: string;
  categoryId: string;
  tags: string[];
  difficulty: number;
};
type QuestionIssue = { path: string; message: string };
export const normalizeTag = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

export function readingIssues(readings: string[]): QuestionIssue[] {
  const issues: QuestionIssue[] = [];
  const branches = new Map<string, Set<string>>();
  const normalized = readings.map((reading) => reading.normalize('NFKC').trim());
  normalized.forEach((reading, index) => {
    const letters = graphemes(reading);
    if (!/^[ぁ-ゖー]+$/u.test(reading) || letters.length > 20)
      issues.push({
        path: `readings.${index}`,
        message: '読みはひらがな・長音の1〜20文字です。',
      });
    let prefix = '';
    for (const letter of letters) {
      if (normalized.includes(prefix)) break;
      const next = branches.get(prefix) ?? new Set<string>();
      next.add(letter);
      branches.set(prefix, next);
      prefix += letter;
    }
  });
  for (const [prefix, next] of branches) {
    if (next.size > 4)
      issues.push({
        path: 'readings',
        message: `「${prefix || '先頭'}」の次文字が${next.size}種類あり、4択に収まりません。`,
      });
  }
  return issues;
}

export const emptyQuestion = (): QuestionInput => ({
  text: '',
  displayAnswer: '',
  readings: [''],
  traps: [],
  explanation: '',
  evidence: '',
  source: '',
  categoryId: '',
  tags: [],
  difficulty: 0,
});

export function validateQuestionInput(
  value: unknown,
  submitting = true,
): { value: QuestionInput; issues: QuestionIssue[] } {
  const issues: QuestionIssue[] = [];
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const result = emptyQuestion();
  const limits = {
    text: 150,
    displayAnswer: 20,
    explanation: 300,
    evidence: 1000,
    source: 1000,
    categoryId: 64,
  };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(result, key))
      issues.push({ path: key, message: '未対応の項目です。' });
  }
  for (const [key, limit] of Object.entries(limits) as [keyof typeof limits, number][]) {
    const text = input[key];
    if (typeof text !== 'string')
      issues.push({ path: key, message: '文字列を入力してください。' });
    else {
      result[key] = text;
      if (
        graphemes(text).length > limit ||
        (submitting && key !== 'source' && !text.trim())
      )
        issues.push({
          path: key,
          message: `${key === 'source' ? '0' : '1'}〜${limit}文字で入力してください。`,
        });
    }
  }
  if (
    !Number.isInteger(input.difficulty) ||
    Number(input.difficulty) < 0 ||
    Number(input.difficulty) > 2
  )
    issues.push({ path: 'difficulty', message: '難易度を選択してください。' });
  else result.difficulty = Number(input.difficulty);
  if (
    !Array.isArray(input.readings) ||
    input.readings.some((reading) => typeof reading !== 'string') ||
    input.readings.length > 8
  )
    issues.push({ path: 'readings', message: '読みは1〜8種類です。' });
  else {
    result.readings = [
      ...new Set(
        input.readings
          .map((reading: string) => reading.normalize('NFKC').trim())
          .filter(Boolean),
      ),
    ];
    if (submitting && !result.readings.length)
      issues.push({ path: 'readings', message: '正解の読みを入力してください。' });
    issues.push(...readingIssues(result.readings));
  }
  if (
    !Array.isArray(input.tags) ||
    input.tags.length > 10 ||
    input.tags.some(
      (tag) => typeof tag !== 'string' || !tag.trim() || graphemes(tag).length > 32,
    )
  )
    issues.push({ path: 'tags', message: 'タグは各1〜32文字、10個以内です。' });
  else
    result.tags = [
      ...new Map(
        input.tags.map((tag: string) => [normalizeTag(tag), tag.trim()]),
      ).values(),
    ];
  if (!Array.isArray(input.traps) || input.traps.length > 16)
    issues.push({ path: 'traps', message: 'ひっかけは16件以内です。' });
  else
    input.traps.forEach((trap: unknown, index: number) => {
      const item = trap as { answer?: unknown; reading?: unknown } | null;
      if (
        !item ||
        typeof item.answer !== 'string' ||
        !item.answer.trim() ||
        graphemes(item.answer).length > 20 ||
        typeof item.reading !== 'string' ||
        readingIssues([item.reading]).length ||
        result.readings.includes(item.reading.normalize('NFKC').trim())
      )
        issues.push({
          path: `traps.${index}`,
          message: '答えと読みは1〜20文字で、正解と異なる読みを入力してください。',
        });
      else if (!result.traps.some((trap) => trap.reading === item.reading))
        result.traps.push({
          answer: item.answer,
          reading: item.reading.normalize('NFKC').trim(),
        });
    });
  return { value: result, issues };
}

export type SubmissionStatus =
  | 'draft'
  | 'pending'
  | 'returned'
  | 'approved'
  | 'rejected'
  | 'ended';
export const statusLabels: Record<SubmissionStatus, string> = {
  draft: '下書き',
  pending: '審査中',
  returned: '差戻し',
  approved: '承認済み',
  rejected: '却下',
  ended: '審査終了',
};
export type Submission = {
  shared?: {
    expired: boolean;
    excluded?: boolean;
    peerOrigin?: string;
    sourceInstanceId?: string;
    sourceCategory?: { id: string; name: string };
  };
  provenance?: { author: string; instance: string } | null;
  deletedAt?: string | null;
  reviewHold?: boolean;
  metrics?: {
    rate: number | null;
    trials: number;
    difficulty: number;
    fixed: boolean;
    reports: number;
    review: boolean;
  };
  id: string;
  seriesId: string;
  authorId: string;
  revision: number;
  status: SubmissionStatus;
  input: QuestionInput;
  reason: string;
  publishedId: string | null;
  stopped: boolean;
  updatedAt: string;
};
export type QuestionSettings = {
  mode: SubmissionMode;
  authorWaitDays: number;
  showAuthor: boolean;
  reportThreshold: number;
  categoryReportThreshold: number;
  rankBoundaries?: [number, number];
  difficultyWeights?: number[][];
  categoryWeights?: Record<string, number>;
};

export type QuestionSelection = {
  authorNames?: Record<string, string>;
  band: number;
  boundaries: [number, number];
  weights: number[];
  categories: Record<string, number>;
  revision: number;
};
export const defaultQuestionSettings: QuestionSettings = {
  mode: 'review',
  authorWaitDays: 30,
  showAuthor: false,
  reportThreshold: 5,
  categoryReportThreshold: 5,
};
export type QuestionOverview = {
  sharedSourceCategories?: {
    peerOrigin: string;
    instanceId: string;
    id: string;
    name: string;
  }[];
  sharedSources?: { peerOrigin: string; instanceId: string; name: string }[];
  reportedOriginals?: Record<
    string,
    { text: string; displayAnswer?: string; answer: string; explanation: string }
  >;
  authorNames?: Record<string, string>;
  pagination?: { page: number; pageSize: number; total: number };
  categoryRequests: { submissionId: string; categoryId: string; reason: string }[];
  reviewCases: {
    questionId: string;
    kind: 'defect' | 'category';
    round: number;
    count: number;
    resolved: boolean;
    reason: string;
  }[];
  reports: {
    id: string;
    questionId: string;
    kind: 'defect' | 'category';
    round: number;
    reason: string;
    suggestedCategory: string;
  }[];
  difficulty: {
    seriesId: string;
    generation: string;
    current: number;
    fixed: boolean;
    revision: number;
    reason: string;
    stats: {
      band: number;
      players: number;
      trials: number;
      correct: number;
      participants: number;
      lower: number;
      upper: number;
    }[];
  }[];
  actorId: string;
  administrator: boolean;
  review: boolean;
  manageAuthors: boolean;
  qualified: boolean;
  settings: QuestionSettings;
  settingsRevision: number;
  submissions: Submission[];
  categories: {
    id: string;
    name: string;
    active: boolean;
    importOnly?: boolean;
    revision: number;
  }[];
  tags: { name: string; aliases: string[] }[];
  authors: {
    actorId: string;
    status: string;
    reason: string;
    retryAt: string | null;
    revision: number;
  }[];
  notifications: QuestionNotification[];
};

export { pageSizes as questionPageSizes } from './pagination.ts';
export const questionViews = [
  'new',
  'edit',
  'import',
  'qualification',
  'categoryRequest',
  'decision',
  'reports',
  'categoryRequests',
  'tags',
  'authors',
  'categories',
  'settings',
  'selection',
] as const;
export type QuestionView = { page: (typeof questionViews)[number]; id?: string | null };
export type QuestionListQuery = {
  scope: 'mine' | 'all' | 'pending';
  band?: 'all' | number;
  players?: 'all' | number;
  sort?: string;
  direction?: 'asc' | 'desc';
  page: number;
  pageSize: number;
  query: string;
  status: string;
  category: string;
  shared?: 'all' | 'local' | 'shared' | 'excluded';
  sourceInstanceId?: string;
  peerOrigin?: string;
  sourceCategory?: string;
};

export function canSubmitQuestion(
  mode: SubmissionMode,
  administrator: boolean,
  qualified: boolean,
) {
  return (
    administrator ||
    mode === 'review' ||
    mode === 'open' ||
    (mode === 'qualified' && qualified)
  );
}

export function canReviewQuestion(
  administrator: boolean,
  reviewer: boolean,
  authorId: string,
  actorId: string,
) {
  return administrator || (reviewer && authorId !== actorId);
}

export type QuestionNotification = {
  id: string;
  message: string;
  createdAt: string;
  read: boolean;
  target?: { page: 'edit' | 'qualification' | 'profile'; id?: string } | null;
};
