import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { parseQuestionJson } from '../../shared/question-json.ts';
import { parseTransfer, type TransferQuestion } from '../../shared/question-transfer.ts';
import {
  canReviewQuestion,
  canSubmitQuestion,
  defaultQuestionSettings,
  normalizeTag,
  type QuestionInput,
  type QuestionListQuery,
  type QuestionOverview,
  type QuestionSettings,
  type QuestionView,
  questionPageSizes,
  questionViews,
  statusLabels,
  submissionModes,
  validateQuestionInput,
} from '../../shared/questions.ts';
import { compareValues, questionSortKeys, sortInput } from '../../shared/sorting.ts';
import { contentHash } from '../catalog/hash.ts';
import {
  questionAuthors as authors,
  questionReviewCases as cases,
  questionCategories as categories,
  questionDifficulty as difficulty,
  questionSubmissionEvents as events,
  questionImports as imports,
  moderationRequests,
  questionNotifications as notifications,
  organizationAccounts,
  questionAvailability,
  questionVersions,
  questionReports as reports,
  questionSettings as settings,
  questionSubmissions as submissions,
  questionTags as tags,
} from '../db/schema.ts';
import { orderValue } from '../db/sorting.ts';
import { dummyCharacters } from '../game/questions.ts';
import {
  OrganizationError,
  requireAdministrator,
  validId,
} from '../organization/access.ts';
import { resolveInstance } from '../organization/database.ts';
import { requireUnrestricted } from '../organization/moderation.ts';
import type { ResultRecord } from '../results/record';
import { publishQuestionCatalog } from './catalog.ts';
import { republishQuestionMetadata } from './metadata.ts';
import { questionStatistics } from './statistics.ts';

type Database = Pick<
  PostgresJsDatabase,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'
>;
export class QuestionError extends OrganizationError {
  readonly issues: { path: string; message: string }[];
  constructor(
    code: string,
    status: 400 | 403 | 404 | 409 = 400,
    issues: { path: string; message: string }[] = [],
  ) {
    super(code, status);
    this.issues = issues;
  }
}
const fail = (code: string, status: 400 | 403 | 404 | 409 = 403): never => {
  throw new QuestionError(code, status);
};
const reasonFor = (input: Record<string, unknown>, required = true) => {
  if (
    typeof input.reason !== 'string' ||
    input.reason.length > 1000 ||
    (required && !input.reason.trim())
  )
    fail('REASON_REQUIRED', 400);
  return (input.reason as string).trim();
};

export async function recordQuestionReport(
  tx: Pick<Database, 'select' | 'insert'>,
  instanceId: string,
  actorId: string,
  input: Record<string, unknown>,
  observedQuestion?: { id: string },
) {
  if (!observedQuestion || observedQuestion.id !== input.questionId)
    throw new QuestionError('QUESTION_NOT_FOUND', 404);
  if (input.kind !== 'defect' && input.kind !== 'category') fail('INVALID_REPORT', 400);
  const kind = input.kind as 'defect' | 'category',
    reason = reasonFor(input);
  const suggestedCategory =
    typeof input.suggestedCategory === 'string' ? input.suggestedCategory.trim() : '';
  if (suggestedCategory.length > 80) fail('INVALID_REPORT', 400);
  const [latest] = await tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.instanceId, instanceId),
        eq(cases.questionId, observedQuestion.id),
        eq(cases.kind, kind),
      ),
    )
    .orderBy(desc(cases.round))
    .limit(1);
  const round = latest ? latest.round + (latest.resolved ? 1 : 0) : 1;
  const inserted = await tx
    .insert(reports)
    .values({
      id: crypto.randomUUID(),
      instanceId,
      questionId: observedQuestion.id,
      kind,
      round,
      actorId,
      reason,
      suggestedCategory,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) fail('ALREADY_REPORTED', 409);
  await tx
    .insert(cases)
    .values({ instanceId, questionId: observedQuestion.id, kind, round, count: 1 })
    .onConflictDoUpdate({
      target: [cases.instanceId, cases.questionId, cases.kind, cases.round],
      set: { count: sql`${cases.count} + 1` },
    });
  return { ok: true };
}

async function notify(
  db: Database,
  instanceId: string,
  actorId: string,
  message: string,
  target: { page: 'edit' | 'qualification'; id?: string },
) {
  await db
    .insert(notifications)
    .values({ id: crypto.randomUUID(), instanceId, actorId, message, target });
}
async function context(db: Database, subject: string, instanceId: string) {
  const resolved = await resolveInstance(db, subject, instanceId, true);
  await db.execute(
    sql`select set_config('quiz.organization_id', ${resolved.organization.id}, true)`,
  );
  const [configuration] = await db
    .select()
    .from(settings)
    .where(eq(settings.instanceId, instanceId));
  const [author] = await db
    .select()
    .from(authors)
    .where(
      and(
        eq(authors.instanceId, instanceId),
        eq(authors.actorId, resolved.account.actorId),
      ),
    );
  return {
    ...resolved,
    configuration,
    config: configuration?.config ?? defaultQuestionSettings,
    author,
    review: resolved.account.administrator || resolved.permissions.includes('questions'),
    manageAuthors:
      resolved.account.administrator || resolved.permissions.includes('authors'),
  };
}

function listQuery(value: unknown): QuestionListQuery | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_QUERY', 400);
  const input = value as Record<string, unknown>;
  if (
    !['mine', 'all', 'pending'].includes(String(input.scope)) ||
    !Number.isSafeInteger(input.page) ||
    Number(input.page) < 1 ||
    Number(input.page) > 1000000 ||
    !(questionPageSizes as readonly unknown[]).includes(input.pageSize) ||
    typeof input.query !== 'string' ||
    input.query.length > 150 ||
    typeof input.category !== 'string' ||
    typeof input.status !== 'string' ||
    !['', 'stopped', 'deleted', ...Object.keys(statusLabels)].includes(input.status)
  )
    fail('INVALID_QUERY', 400);
  try {
    sortInput(input, questionSortKeys, 'updatedAt');
  } catch {
    fail('INVALID_QUERY', 400);
  }
  if (input.category) validId(input.category);
  if (
    input.band !== undefined &&
    !['all', 0, 1, 2].includes(input.band as string | number)
  )
    fail('INVALID_QUERY', 400);
  if (
    input.players !== undefined &&
    !['all', 2, 3, 4].includes(input.players as string | number)
  )
    fail('INVALID_QUERY', 400);
  return { ...input, query: normalizeTag(input.query as string) } as QuestionListQuery;
}

async function readQuestionOverview(
  db: Database,
  subject: string,
  instanceId: string,
  list?: QuestionListQuery,
  view?: QuestionView,
  readRecords?: (owner: string) => Promise<ResultRecord[]>,
): Promise<QuestionOverview> {
  const ctx = await context(db, subject, instanceId);
  if (list && list.scope !== 'mine' && !ctx.review) fail('REVIEW_FORBIDDEN');
  const needs = (...pages: QuestionView['page'][]) =>
    (!view && !list) || (!!view && pages.includes(view.page));
  if (view) {
    if (['categories', 'settings', 'selection'].includes(view.page))
      requireAdministrator(ctx.account);
    else if (view.page === 'authors') {
      if (!ctx.manageAuthors) fail('REVIEW_FORBIDDEN');
    } else if (
      ['decision', 'reports', 'categoryRequests', 'tags'].includes(view.page) &&
      !ctx.review
    )
      fail('REVIEW_FORBIDDEN');
  }
  const detail = view && ['edit', 'decision', 'categoryRequest'].includes(view.page);
  const knownTags =
    list || needs('new', 'edit', 'tags')
      ? await db
          .select({ name: tags.name, aliases: tags.aliases })
          .from(tags)
          .where(eq(tags.instanceId, instanceId))
      : [];
  const matchingTags = list?.query
    ? knownTags
        .filter((tag) =>
          [tag.name, ...tag.aliases].some((name) =>
            normalizeTag(name).includes(list.query),
          ),
        )
        .map((tag) => tag.name)
    : [];
  const text = sql`lower(regexp_replace(normalize(concat_ws(' ', ${submissions.input}->>'text', ${submissions.input}->>'displayAnswer', array_to_string(array(select jsonb_array_elements_text(${submissions.input}->'readings')), ' '), array_to_string(array(select jsonb_array_elements_text(${submissions.input}->'tags')), ' ')), NFKC), '[[:space:]]+', ' ', 'g'))`;
  const scope = and(
    eq(submissions.instanceId, instanceId),
    detail ? eq(submissions.id, view.id as string) : undefined,
    detail
      ? undefined
      : list?.status === 'deleted'
        ? isNotNull(submissions.deletedAt)
        : isNull(submissions.deletedAt),
    !ctx.review ||
      list?.scope === 'mine' ||
      view?.page === 'edit' ||
      view?.page === 'categoryRequest'
      ? eq(submissions.authorId, ctx.account.actorId)
      : undefined,
    list?.scope === 'pending'
      ? eq(submissions.status, 'pending')
      : list?.status === 'stopped'
        ? or(eq(submissions.stopped, true), eq(submissions.reviewHold, true))
        : list?.status && list.status !== 'deleted'
          ? eq(submissions.status, list.status as keyof typeof statusLabels)
          : undefined,
    list?.category
      ? sql`${submissions.input}->>'categoryId' = ${list.category}`
      : undefined,
    list?.query
      ? or(
          sql`position(${list.query} in ${text}) > 0`,
          ...matchingTags.map(
            (tag) =>
              sql`(${submissions.input}->'tags') @> ${JSON.stringify([tag])}::jsonb`,
          ),
        )
      : undefined,
  );
  const total = list
    ? (await db.select({ value: count() }).from(submissions).where(scope))[0].value
    : 0;
  const page = list
    ? Math.min(list.page, Math.max(1, Math.ceil(total / list.pageSize)))
    : 1;
  const sorting = sortInput(list ?? {}, questionSortKeys, 'updatedAt');
  const sortValues = {
    text: sql`nullif(${submissions.input}->>'text', '')`,
    answer: sql`nullif(${submissions.input}->>'displayAnswer', '')`,
    status: sql`(${JSON.stringify(statusLabels)}::jsonb ->> ${submissions.status}) || case when ${submissions.stopped} then '・使用停止中' else '' end`,
    category: sql`(select name from quiz_game.question_categories where id::text = ${submissions.input}->>'categoryId' and instance_id = ${instanceId})`,
    author: sql`coalesce(${submissions.provenance}->>'author', (select display_name from quiz_game.organization_accounts where actor_id = ${submissions.authorId}))`,
    updatedAt: submissions.updatedAt,
  };
  const metricSort = [
    'rate',
    'trials',
    'difficulty',
    'fixed',
    'reports',
    'review',
  ].includes(sorting.sort);
  const query = db
    .select()
    .from(submissions)
    .where(scope)
    .orderBy(
      orderValue(
        sortValues[sorting.sort as keyof typeof sortValues] ?? submissions.updatedAt,
        sorting.direction,
      ),
      desc(submissions.id),
    )
    .$dynamic();
  let rows = list
    ? metricSort
      ? await query
      : await query.limit(list.pageSize).offset((page - 1) * list.pageSize)
    : detail || needs('reports', 'categoryRequests')
      ? await query
      : [];
  const levels =
    ctx.review && (list || needs())
      ? await db.select().from(difficulty).where(eq(difficulty.instanceId, instanceId))
      : [];
  if (levels.length && readRecords) {
    const records = await readRecords(ctx.instance.owner);
    for (const level of levels)
      level.stats = questionStatistics(records, level.generation);
  }
  const reviewCases =
    ctx.review && (list || needs('reports'))
      ? await db.select().from(cases).where(eq(cases.instanceId, instanceId))
      : [];
  const reportedOriginals: NonNullable<QuestionOverview['reportedOriginals']> = {};
  if (
    ctx.review &&
    needs('reports') &&
    readRecords &&
    reviewCases.some((reviewCase) => reviewCase.questionId.startsWith('original-'))
  ) {
    const reported = new Set(reviewCases.map((reviewCase) => reviewCase.questionId));
    for (const record of await readRecords(ctx.instance.owner)) {
      if (
        !record.definition.original ||
        Date.now() - record.result.finishedAt >= 30 * 86400000
      )
        continue;
      for (const question of record.completedQuestions ?? [])
        if (reported.has(question.id))
          reportedOriginals[question.id] = {
            text: question.text,
            answer: question.readings[0],
            displayAnswer: question.displayAnswer,
            explanation: question.explanation,
          };
    }
  }
  const metrics = new Map<
    string,
    NonNullable<QuestionOverview['submissions'][number]['metrics']>
  >();
  if (list && ctx.review) {
    const versions = await db
      .select({
        id: questionVersions.questionId,
        series: sql<string>`${questionVersions.payload}->>'seriesId'`,
      })
      .from(questionVersions)
      .where(eq(questionVersions.owner, ctx.instance.owner));
    for (const row of rows) {
      const level = levels.find(
        (candidateLevel) => candidateLevel.seriesId === row.seriesId,
      );
      const stats = (level?.stats ?? []).filter(
        (statsSample) =>
          (list.band === undefined ||
            list.band === 'all' ||
            statsSample.band === list.band) &&
          (list.players === undefined ||
            list.players === 'all' ||
            statsSample.players === list.players),
      );
      const trials = stats.reduce((sum, statsSample) => sum + statsSample.trials, 0),
        correct = stats.reduce((sum, statsSample) => sum + statsSample.correct, 0);
      const pending = reviewCases.filter(
        (reviewCase) =>
          !reviewCase.resolved &&
          (reviewCase.questionId === row.publishedId ||
            versions.some(
              (questionVersion) =>
                questionVersion.id === reviewCase.questionId &&
                questionVersion.series === row.seriesId,
            )),
      );
      metrics.set(row.id, {
        rate: trials ? correct / trials : null,
        trials,
        difficulty: level?.current ?? row.input.difficulty,
        fixed: level?.fixed ?? false,
        reports: pending.reduce((sum, reviewCase) => sum + reviewCase.count, 0),
        review: pending.some(
          (reviewCase) =>
            reviewCase.count >=
            (reviewCase.kind === 'defect'
              ? ctx.config.reportThreshold
              : ctx.config.categoryReportThreshold),
        ),
      });
    }
    if (metricSort)
      rows = rows
        .sort((leftSubmission, rightSubmission) => {
          const key = sorting.sort as keyof NonNullable<
            QuestionOverview['submissions'][number]['metrics']
          >;
          const value = (submission: typeof leftSubmission) => {
            const metricValue = metrics.get(submission.id)?.[key] ?? null;
            return typeof metricValue === 'boolean' ? Number(metricValue) : metricValue;
          };
          return (
            compareValues(
              value(leftSubmission),
              value(rightSubmission),
              sorting.direction,
            ) || rightSubmission.id.localeCompare(leftSubmission.id)
          );
        })
        .slice((page - 1) * list.pageSize, page * list.pageSize);
  }
  const categoryEvents =
    rows.length && needs('categoryRequest', 'categoryRequests')
      ? await db
          .select()
          .from(events)
          .where(
            and(
              eq(events.instanceId, instanceId),
              inArray(
                events.submissionId,
                rows.map((row) => row.id),
              ),
              inArray(events.action, [
                'category-request',
                'category-rejected',
                'classify',
                'category-move',
              ]),
            ),
          )
          .orderBy(desc(events.createdAt))
      : [];
  const latestCategory = new Map<string, typeof events.$inferSelect>();
  for (const event of categoryEvents)
    if (!latestCategory.has(event.submissionId))
      latestCategory.set(event.submissionId, event);
  return {
    authorNames: Object.fromEntries(
      (rows.length
        ? await db
            .select({
              id: organizationAccounts.actorId,
              name: sql<string>`case when ${organizationAccounts.withdrawnAt} is not null then '退会ユーザー' else ${organizationAccounts.displayName} end`,
            })
            .from(organizationAccounts)
            .where(
              inArray(
                organizationAccounts.actorId,
                rows.map((submission) => submission.authorId),
              ),
            )
        : []
      ).map((account) => [account.id, account.name ?? '表示名未登録']),
    ),
    ...(list ? { pagination: { page, pageSize: list.pageSize, total } } : {}),
    categoryRequests: [...latestCategory.values()]
      .filter((event) => event.action === 'category-request')
      .map((event) => ({
        submissionId: event.submissionId,
        categoryId: event.input.categoryId,
        reason: event.reason,
      })),
    actorId: ctx.account.actorId,
    administrator: ctx.account.administrator,
    review: ctx.review,
    manageAuthors: ctx.manageAuthors,
    qualified: ctx.author?.status === 'qualified',
    settings: ctx.config,
    settingsRevision: ctx.configuration?.revision ?? 0,
    reviewCases,
    ...(ctx.review && needs('reports') ? { reportedOriginals } : {}),
    reports:
      ctx.review && needs('reports')
        ? await db.select().from(reports).where(eq(reports.instanceId, instanceId))
        : [],
    difficulty: levels,
    submissions: rows.map((row) => ({ ...row, metrics: metrics.get(row.id) })),
    categories:
      list ||
      needs(
        'new',
        'import',
        'edit',
        'categoryRequest',
        'categoryRequests',
        'categories',
        'selection',
      )
        ? await db
            .select()
            .from(categories)
            .where(eq(categories.instanceId, instanceId))
            .orderBy(asc(categories.name))
        : [],
    tags: knownTags,
    authors: !needs('authors', 'qualification')
      ? []
      : await db
          .select()
          .from(authors)
          .where(
            and(
              eq(authors.instanceId, instanceId),
              ctx.manageAuthors ? undefined : eq(authors.actorId, ctx.account.actorId),
            ),
          ),
    notifications:
      list || view
        ? []
        : await db
            .select()
            .from(notifications)
            .where(
              and(
                eq(notifications.instanceId, instanceId),
                eq(notifications.actorId, ctx.account.actorId),
                sql`${notifications.createdAt} > now() - interval '90 days'`,
              ),
            )
            .orderBy(desc(notifications.createdAt))
            .limit(100),
  };
}

export async function questionOverview(
  db: PostgresJsDatabase,
  subject: string,
  instanceId: string,
  input?: unknown,
  viewInput?: unknown,
  readRecords?: (owner: string) => Promise<ResultRecord[]>,
): Promise<QuestionOverview> {
  const list = listQuery(input);
  let view: QuestionView | undefined;
  if (viewInput !== undefined) {
    if (list || !viewInput || typeof viewInput !== 'object' || Array.isArray(viewInput))
      fail('INVALID_QUERY', 400);
    const value = viewInput as Record<string, unknown>;
    if (!(questionViews as readonly unknown[]).includes(value.page))
      fail('INVALID_QUERY', 400);
    if (['edit', 'decision', 'categoryRequest'].includes(String(value.page))) {
      try {
        validId(value.id);
      } catch {
        fail('INVALID_QUERY', 400);
      }
    }
    view = value as QuestionView;
  }
  return db.transaction((tx) =>
    readQuestionOverview(tx, subject, instanceId, list, view, readRecords),
  );
}

async function audit(
  db: Database,
  row: typeof submissions.$inferSelect,
  actorId: string,
  action: string,
) {
  await db.insert(events).values({
    id: crypto.randomUUID(),
    instanceId: row.instanceId,
    submissionId: row.id,
    revision: row.revision,
    actorId,
    action,
    input: row.input,
    reason: row.reason,
  });
}

async function publish(
  db: Database,
  ctx: Awaited<ReturnType<typeof context>>,
  row: typeof submissions.$inferSelect,
) {
  const id = crypto.randomUUID();
  const owner = ctx.instance.owner;
  const questionInput = row.input;
  const [previous] = row.publishedId
    ? await db
        .select()
        .from(questionVersions)
        .where(
          and(
            eq(questionVersions.owner, owner),
            eq(questionVersions.questionId, row.publishedId),
          ),
        )
    : [];
  const core = (value: {
    text: string;
    displayAnswer?: string;
    readings?: string[];
    traps?: { answer: string; reading: string }[];
  }) => ({
    text: value.text,
    displayAnswer: value.displayAnswer,
    readings: value.readings,
    traps: value.traps ?? [],
  });
  const generation =
    previous &&
    (await contentHash(core(previous.payload))) ===
      (await contentHash(core(questionInput)))
      ? (previous.payload.generation ?? id)
      : id;
  const [currentDifficulty] = await db
    .select()
    .from(difficulty)
    .where(
      and(
        eq(difficulty.instanceId, row.instanceId),
        eq(difficulty.seriesId, row.seriesId),
      ),
    );
  const effectiveDifficulty =
    currentDifficulty?.fixed || currentDifficulty?.generation === generation
      ? currentDifficulty.current
      : questionInput.difficulty;
  await db
    .insert(difficulty)
    .values({
      instanceId: row.instanceId,
      seriesId: row.seriesId,
      generation,
      current: effectiveDifficulty,
    })
    .onConflictDoUpdate({
      target: [difficulty.instanceId, difficulty.seriesId],
      set: {
        generation,
        current: effectiveDifficulty,
        revision: (currentDifficulty?.revision ?? 0) + 1,
        ...(currentDifficulty?.generation !== generation
          ? {
              stats: [],
              lastDay: null,
              cursor: null,
              reason: '改訂により集計を開始しました。',
            }
          : {}),
      },
    });
  await db.insert(questionVersions).values({
    owner,
    questionId: id,
    version: 1,
    payload: {
      id,
      version: 1,
      text: questionInput.text,
      answer: questionInput.readings[0],
      readings: questionInput.readings,
      displayAnswer: questionInput.displayAnswer,
      explanation: questionInput.explanation,
      source: questionInput.source || '投稿問題',
      permission: 'instance',
      demoAllowed: true,
      distractors: dummyCharacters,
      traps: questionInput.traps,
      categoryId: questionInput.categoryId,
      difficulty: effectiveDifficulty,
      seriesId: row.seriesId,
      generation,
    },
  });
  await db.insert(questionAvailability).values({
    owner,
    questionId: id,
    retiredAt:
      row.stopped || row.reviewHold || row.deletedAt ? new Date().toISOString() : null,
  });
  if (row.publishedId)
    await db
      .update(questionAvailability)
      .set({ retiredAt: new Date().toISOString() })
      .where(
        and(
          eq(questionAvailability.owner, owner),
          eq(questionAvailability.questionId, row.publishedId),
        ),
      );
  return id;
}

async function checkedInput(
  db: Database,
  instanceId: string,
  input: unknown,
  submitting: boolean,
): Promise<QuestionInput> {
  const parsed = validateQuestionInput(input, submitting);
  if (parsed.issues.length)
    throw new QuestionError('INVALID_QUESTION', 400, parsed.issues);
  if (submitting) {
    const [category] = await db
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.instanceId, instanceId),
          eq(categories.id, validId(parsed.value.categoryId)),
          eq(categories.active, true),
        ),
      );
    if (!category) fail('CATEGORY_REQUIRED', 400);
  }
  for (const name of parsed.value.tags)
    await db
      .insert(tags)
      .values({ instanceId, key: normalizeTag(name), name, aliases: [] })
      .onConflictDoNothing();
  const known = await db.select().from(tags).where(eq(tags.instanceId, instanceId));
  parsed.value.tags = [
    ...new Set(
      parsed.value.tags.map(
        (name) => known.find((tag) => tag.key === normalizeTag(name))?.name ?? name,
      ),
    ),
  ];
  return parsed.value;
}

export async function questionMutation(
  db: PostgresJsDatabase,
  subject: string,
  instanceId: string,
  input: Record<string, unknown>,
  profile = 'local',
  observedQuestion?: NonNullable<ResultRecord['completedQuestions']>[number],
  authorName = '作問者',
) {
  validId(instanceId);
  return db.transaction(async (tx) => {
    // Serialize state transitions, mode changes and eligibility revocations within this instance.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${instanceId}`}, 0))`,
    );
    const ctx = await context(tx, subject, instanceId);
    authorName = ctx.account.displayName ?? authorName;
    // Transaction-local RLS scope is derived from the authenticated account, not the request.
    await tx.execute(
      sql`select set_config('quiz.organization_id', ${ctx.organization.id}, true)`,
    );
    const actorId = ctx.account.actorId;
    const operation = input.operation;
    if (
      ctx.instance.state === 'archived' &&
      ![
        'export',
        'export-managed',
        'notifications',
        'read-notifications',
        'history',
      ].includes(String(operation))
    )
      fail('INSTANCE_ARCHIVED', 409);
    if (operation === 'submit' && !ctx.account.displayName) fail('PROFILE_REQUIRED', 409);
    if (operation === 'submit')
      await requireUnrestricted(tx, ctx.organization.id, actorId, instanceId, 'submit');
    const scope = eq(submissions.instanceId, instanceId);
    if (operation === 'export-managed') {
      if (!ctx.review) fail('REVIEW_FORBIDDEN');
      const ids = input.ids;
      if (input.all !== true && (!Array.isArray(ids) || !ids.length))
        fail('INVALID_CHANGES', 400);
      const rows = await tx
        .select()
        .from(submissions)
        .where(
          and(
            scope,
            input.all === true
              ? and(eq(submissions.status, 'approved'), isNull(submissions.deletedAt))
              : inArray(submissions.id, (ids as unknown[]).map(validId)),
          ),
        )
        .orderBy(asc(submissions.id));
      if (input.all !== true && rows.length !== new Set(ids as string[]).size)
        fail('QUESTION_NOT_FOUND', 404);
      const categoryRows = await tx
        .select()
        .from(categories)
        .where(eq(categories.instanceId, instanceId));
      const questions: TransferQuestion[] = rows.map((submission) => ({
        input: submission.input,
        category:
          categoryRows.find((reviewCase) => reviewCase.id === submission.input.categoryId)
            ?.name ?? '',
        stopped: submission.stopped || submission.reviewHold,
        provenance: submission.provenance ?? {
          author: submission.authorName,
          instance: ctx.instance.name,
        },
      }));
      return { questions };
    }
    if (operation === 'report') {
      return recordQuestionReport(tx, instanceId, actorId, input, observedQuestion);
    }
    if (operation === 'resolve-report') {
      if (!ctx.review) fail('REVIEW_FORBIDDEN');
      const reason = reasonFor(input);
      const updated = await tx
        .update(cases)
        .set({ resolved: true, reason, resolvedAt: new Date().toISOString() })
        .where(
          and(
            eq(cases.instanceId, instanceId),
            eq(cases.questionId, String(input.questionId)),
            eq(cases.kind, input.kind as 'defect' | 'category'),
            eq(cases.round, Number(input.round)),
            eq(cases.resolved, false),
          ),
        )
        .returning();
      if (!updated.length) fail('EDIT_CONFLICT', 409);
      const [version] = await tx
        .select()
        .from(questionVersions)
        .where(
          and(
            eq(questionVersions.owner, ctx.instance.owner),
            eq(questionVersions.questionId, String(input.questionId)),
          ),
        );
      if (version?.payload.seriesId) {
        const [submission] = await tx
          .select()
          .from(submissions)
          .where(and(scope, eq(submissions.seriesId, version.payload.seriesId)));
        if (submission)
          await notify(
            tx,
            instanceId,
            submission.authorId,
            `問題の再審議が解決しました：${reason}`,
            { page: 'edit', id: submission.id },
          );
      }
      return { ok: true };
    }
    if (operation === 'notifications') {
      return {
        notifications: await tx
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.instanceId, instanceId),
              eq(notifications.actorId, actorId),
              sql`${notifications.createdAt} > now() - interval '90 days'`,
            ),
          )
          .orderBy(desc(notifications.createdAt))
          .limit(5),
      };
    }
    if (operation === 'read-notifications') {
      if (
        !Array.isArray(input.ids) ||
        input.ids.length > 5 ||
        input.ids.some((id) => typeof id !== 'string')
      )
        fail('INVALID_OPERATION', 400);
      const ids = (input.ids as string[]).map(validId);
      if (!ids.length) return { ok: true };
      await tx
        .update(notifications)
        .set({ read: true })
        .where(
          and(
            eq(notifications.instanceId, instanceId),
            eq(notifications.actorId, actorId),
            inArray(notifications.id, ids),
          ),
        );
      return { ok: true };
    }
    if (operation === 'history') {
      const id = validId(input.id);
      const [row] = await tx
        .select()
        .from(submissions)
        .where(and(scope, eq(submissions.id, id)));
      if (!row || (!ctx.review && row.authorId !== actorId))
        fail('QUESTION_NOT_FOUND', 404);
      const history = await tx
        .select()
        .from(events)
        .where(and(eq(events.instanceId, instanceId), eq(events.submissionId, id)))
        .orderBy(asc(events.createdAt));
      return {
        history: history.map(({ actorId: reviewer, ...event }) => ({
          ...event,
          ...(ctx.review ? { actorId: reviewer } : {}),
        })),
      };
    }
    if (operation === 'export') {
      const rows = await tx
        .select()
        .from(submissions)
        .where(and(scope, eq(submissions.authorId, actorId)))
        .orderBy(asc(submissions.id));
      return { questions: rows.map((row) => row.input) };
    }
    if (
      ctx.instance.state !== 'published' &&
      !ctx.account.administrator &&
      !ctx.permissions.length
    )
      fail('INSTANCE_PREPARING');
    if (operation === 'import-transfer') {
      if (
        !canSubmitQuestion(
          ctx.config.mode,
          ctx.account.administrator,
          ctx.author?.status === 'qualified',
        )
      )
        fail('SUBMISSION_FORBIDDEN');
      const requestId = validId(input.requestId),
        hash = await contentHash({ instanceId, input });
      const [receipt] = await tx
        .select()
        .from(moderationRequests)
        .where(eq(moderationRequests.id, requestId));
      if (receipt) {
        if (receipt.operatorId !== actorId || receipt.requestHash !== hash)
          fail('EDIT_CONFLICT', 409);
        return { ok: true };
      }
      let portable: TransferQuestion[];
      try {
        portable = parseTransfer(String(input.source));
      } catch (error) {
        throw new QuestionError('INVALID_IMPORT', 400, [
          { path: 'JSON', message: (error as Error).message },
        ]);
      }
      if (
        !input.mapping ||
        typeof input.mapping !== 'object' ||
        Array.isArray(input.mapping)
      )
        fail('INVALID_CATEGORY', 400);
      const mapping = input.mapping as Record<string, { id?: string; name?: string }>;
      const mapped = new Map<string, string>();
      for (const name of new Set(
        portable.map((transferredQuestion) => transferredQuestion.category),
      )) {
        const dest = mapping[name];
        if (!dest) fail('INVALID_CATEGORY', 400);
        if (dest.name) {
          requireAdministrator(ctx.account);
          const created = await questionMutation(
            tx,
            subject,
            instanceId,
            { operation: 'category', name: dest.name },
            profile,
          );
          const [category] = await tx
            .select()
            .from(categories)
            .where(
              and(
                eq(categories.instanceId, instanceId),
                eq(categories.name, dest.name.trim()),
              ),
            );
          if (!created || !category) fail('INVALID_CATEGORY', 400);
          mapped.set(name, category.id);
        } else {
          const [category] = await tx
            .select()
            .from(categories)
            .where(
              and(
                eq(categories.instanceId, instanceId),
                eq(categories.id, validId(dest.id)),
                eq(categories.active, true),
              ),
            );
          if (!category) fail('INVALID_CATEGORY', 400);
          mapped.set(name, category.id);
        }
      }
      for (const row of portable) {
        const id = crypto.randomUUID();
        const value = await checkedInput(
          tx,
          instanceId,
          { ...row.input, categoryId: mapped.get(row.category) },
          false,
        );
        const [saved] = await tx
          .insert(submissions)
          .values({
            id,
            instanceId,
            seriesId: id,
            authorId: actorId,
            authorName: row.provenance.author,
            provenance: row.provenance,
            stopped: row.stopped,
            input: value,
          })
          .returning();
        await audit(tx, saved, actorId, 'import');
      }
      await tx.insert(moderationRequests).values({
        id: requestId,
        organizationId: ctx.organization.id,
        operatorId: actorId,
        requestHash: hash,
        details: { instanceId, operation },
      });
      return { ok: true };
    }
    if (operation === 'bulk') {
      if (!ctx.review) fail('REVIEW_FORBIDDEN');
      const requestId = validId(input.requestId),
        hash = await contentHash({ instanceId, input });
      const [previous] = await tx
        .select()
        .from(moderationRequests)
        .where(eq(moderationRequests.id, requestId));
      if (previous) {
        if (previous.operatorId !== actorId || previous.requestHash !== hash)
          fail('EDIT_CONFLICT', 409);
        return { ok: true };
      }
      if (
        ![
          'classify',
          'difficulty',
          'stop',
          'resume',
          'return',
          'delete',
          'restore',
          'approve',
          'reject',
        ].includes(String(input.action)) ||
        !Array.isArray(input.changes) ||
        !input.changes.length ||
        input.changes.length > 500
      )
        fail('INVALID_CHANGES', 400);
      if (
        ['approve', 'reject'].includes(String(input.action)) &&
        (input.changes as unknown[]).length !== 1
      )
        fail('INVALID_CHANGES', 400);
      const changes = input.changes as { id: string; revision: number }[];
      if (new Set(changes.map((change) => change.id)).size !== changes.length)
        fail('DUPLICATE_QUESTION', 400);
      for (const change of changes) {
        try {
          await questionMutation(
            tx,
            subject,
            instanceId,
            { ...input, ...change, operation: input.action, changes: [change] },
            profile,
          );
        } catch (error) {
          if (error instanceof QuestionError) {
            const [target] = await tx
              .select()
              .from(submissions)
              .where(and(scope, eq(submissions.id, validId(change.id))));
            error.issues.push({
              path: target?.input.text || '選択した問題',
              message: error.code,
            });
          }
          throw error;
        }
      }
      await tx.insert(moderationRequests).values({
        id: requestId,
        organizationId: ctx.organization.id,
        operatorId: actorId,
        requestHash: hash,
        details: {
          instanceId,
          action: input.action,
          ids: changes.map((change) => change.id),
        },
      });
      return { ok: true };
    }
    if (operation === 'category') {
      requireAdministrator(ctx.account);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 80) fail('INVALID_NAME', 400);
      if (input.id) {
        if (input.active === false) {
          const [destination] = await tx
            .select()
            .from(categories)
            .where(
              and(
                eq(categories.instanceId, instanceId),
                eq(categories.id, validId(input.destination)),
                eq(categories.active, true),
              ),
            );
          if (!destination || destination.id === input.id) fail('INVALID_CATEGORY', 400);
          const affected = await tx.select().from(submissions).where(scope);
          for (const row of affected) {
            const [published] = row.publishedId
              ? await tx
                  .select()
                  .from(questionVersions)
                  .where(
                    and(
                      eq(questionVersions.owner, ctx.instance.owner),
                      eq(questionVersions.questionId, row.publishedId),
                    ),
                  )
              : [];
            if (published?.payload.categoryId === input.id)
              await republishQuestionMetadata(tx, ctx.instance.owner, row, {
                categoryId: destination.id,
              });
            if (row.input.categoryId === input.id) {
              const [updated] = await tx
                .update(submissions)
                .set({
                  input: { ...row.input, categoryId: destination.id },
                  revision: row.revision + 1,
                })
                .where(eq(submissions.id, row.id))
                .returning();
              await audit(tx, updated, actorId, 'category-move');
            }
          }
        }
        const rows = await tx
          .update(categories)
          .set({
            name,
            active: input.active !== false,
            revision: sql`${categories.revision} + 1`,
          })
          .where(
            and(
              eq(categories.instanceId, instanceId),
              eq(categories.id, validId(input.id)),
              eq(categories.revision, Number(input.revision)),
            ),
          )
          .returning();
        if (!rows.length) fail('EDIT_CONFLICT', 409);
      } else
        await tx.insert(categories).values({ id: crypto.randomUUID(), instanceId, name });
      if (input.active === false)
        await publishQuestionCatalog(tx, instanceId, ctx.instance.owner, profile);
      return { ok: true };
    }
    if (operation === 'request-category' || operation === 'reject-category') {
      const [row] = await tx
        .select()
        .from(submissions)
        .where(and(scope, eq(submissions.id, validId(input.id))));
      if (
        !row ||
        (operation === 'request-category' ? row.authorId !== actorId : !ctx.review)
      )
        fail('QUESTION_NOT_FOUND', 404);
      if (row.deletedAt) fail('QUESTION_DELETED', 409);
      if (row.revision !== input.revision) fail('EDIT_CONFLICT', 409);
      const reason = reasonFor(input, operation === 'reject-category');
      if (operation === 'request-category') {
        const [category] = await tx
          .select()
          .from(categories)
          .where(
            and(
              eq(categories.instanceId, instanceId),
              eq(categories.id, validId(input.categoryId)),
              eq(categories.active, true),
            ),
          );
        if (!category) fail('INVALID_CATEGORY', 400);
        await audit(
          tx,
          { ...row, input: { ...row.input, categoryId: category.id }, reason },
          actorId,
          'category-request',
        );
      } else {
        await audit(tx, { ...row, reason }, actorId, 'category-rejected');
        await notify(
          tx,
          instanceId,
          row.authorId,
          `カテゴリ変更申請を見送りました：${reason}`,
          { page: 'edit', id: row.id },
        );
      }
      return { ok: true };
    }
    if (operation === 'classify' || operation === 'difficulty') {
      if (!ctx.review) fail('REVIEW_FORBIDDEN');
      if (operation === 'difficulty') requireAdministrator(ctx.account);
      if (
        !Array.isArray(input.changes) ||
        !input.changes.length ||
        input.changes.length > 500
      )
        fail('INVALID_CHANGES', 400);
      const changes = input.changes as {
        id: string;
        revision: number;
        categoryId?: string;
        difficulty?: number;
        fixed?: boolean;
      }[];
      if (new Set(changes.map((change) => change.id)).size !== changes.length)
        fail('DUPLICATE_QUESTION', 400);
      for (const change of changes) {
        const [row] = await tx
          .select()
          .from(submissions)
          .where(and(scope, eq(submissions.id, validId(change.id))));
        if (!row) fail('QUESTION_NOT_FOUND', 404);
        if (row.deletedAt) fail('QUESTION_DELETED', 409);
        if (row.revision !== change.revision) fail('EDIT_CONFLICT', 409);
        let value = row.input;
        if (operation === 'classify') {
          const [category] = await tx
            .select()
            .from(categories)
            .where(
              and(
                eq(categories.instanceId, instanceId),
                eq(categories.id, validId(change.categoryId)),
                eq(categories.active, true),
              ),
            );
          if (!category) fail('INVALID_CATEGORY', 400);
          value = { ...value, categoryId: category.id };
          await republishQuestionMetadata(tx, ctx.instance.owner, row, {
            categoryId: category.id,
          });
        } else {
          if (
            ![0, 1, 2].includes(Number(change.difficulty)) ||
            typeof change.fixed !== 'boolean'
          )
            fail('INVALID_DIFFICULTY', 400);
          value = { ...value, difficulty: Number(change.difficulty) };
          await republishQuestionMetadata(tx, ctx.instance.owner, row, {
            difficulty: value.difficulty,
          });
          const settings = {
            current: value.difficulty,
            fixed: change.fixed,
            reason: reasonFor(input),
          };
          await tx
            .insert(difficulty)
            .values({
              instanceId,
              seriesId: row.seriesId,
              generation: row.seriesId,
              ...settings,
            })
            .onConflictDoUpdate({
              target: [difficulty.instanceId, difficulty.seriesId],
              set: { ...settings, revision: sql`${difficulty.revision} + 1` },
            });
        }
        const [updated] = await tx
          .update(submissions)
          .set({ input: value, revision: row.revision + 1 })
          .where(eq(submissions.id, row.id))
          .returning();
        await audit(tx, updated, actorId, operation);
      }
      await publishQuestionCatalog(tx, instanceId, ctx.instance.owner, profile);
      return { ok: true };
    }
    if (operation === 'merge-tags') {
      if (!ctx.review) fail('REVIEW_FORBIDDEN');
      const from = normalizeTag(String(input.from ?? ''));
      const to = normalizeTag(String(input.to ?? ''));
      if (!from || !to || from === to) fail('INVALID_TAG', 400);
      const available = await tx
        .select()
        .from(tags)
        .where(eq(tags.instanceId, instanceId));
      const source = available.find((tag) => tag.key === from);
      const target = available.find((tag) => tag.key === to);
      if (!source || !target) throw new QuestionError('INVALID_TAG', 400);
      const mergedKeys = available
        .filter((tag) => tag.name === source.name || tag.name === target.name)
        .map((tag) => tag.key);
      const aliases = [...new Set([...source.aliases, source.name, ...target.aliases])];
      await tx
        .update(tags)
        .set({ name: target.name, aliases })
        .where(and(eq(tags.instanceId, instanceId), inArray(tags.key, mergedKeys)));
      for (const row of await tx.select().from(submissions).where(scope)) {
        const names = row.input.tags.map((name) =>
          mergedKeys.includes(normalizeTag(name)) ? target.name : name,
        );
        if (JSON.stringify(names) === JSON.stringify(row.input.tags)) continue;
        const [updated] = await tx
          .update(submissions)
          .set({
            input: { ...row.input, tags: [...new Set(names)] },
            revision: row.revision + 1,
          })
          .where(eq(submissions.id, row.id))
          .returning();
        await audit(tx, updated, actorId, 'merge-tags');
      }
      return { ok: true };
    }
    if (operation === 'author-request' || operation === 'author-decision') {
      const target = operation === 'author-request' ? actorId : String(input.actorId);
      if (operation === 'author-decision' && !ctx.manageAuthors)
        fail('AUTHOR_PERMISSION_REQUIRED');
      const [account] = await tx
        .select()
        .from(organizationAccounts)
        .where(
          and(
            eq(organizationAccounts.actorId, target),
            eq(organizationAccounts.organizationId, ctx.organization.id),
          ),
        );
      if (!account) fail('ACCOUNT_NOT_FOUND', 404);
      const [previous] = await tx
        .select()
        .from(authors)
        .where(and(eq(authors.instanceId, instanceId), eq(authors.actorId, target)));
      let status: typeof authors.$inferInsert.status;
      const reason = reasonFor(
        input,
        operation === 'author-decision' && input.decision !== 'qualified',
      );
      if (operation === 'author-request') {
        if (
          previous?.status === 'pending' ||
          previous?.status === 'qualified' ||
          (previous?.retryAt && Date.parse(previous.retryAt) > Date.now())
        )
          fail('AUTHOR_REQUEST_UNAVAILABLE', 409);
        status = 'pending';
      } else {
        if (!['qualified', 'rejected', 'revoked'].includes(String(input.decision)))
          fail('INVALID_OPERATION', 400);
        if ((previous?.revision ?? 0) !== input.revision) fail('EDIT_CONFLICT', 409);
        status = input.decision as typeof status;
      }
      const retryAt =
        status === 'rejected'
          ? new Date(Date.now() + ctx.config.authorWaitDays * 86400000).toISOString()
          : null;
      await tx
        .insert(authors)
        .values({
          instanceId,
          actorId: target,
          status,
          reason,
          retryAt,
          revision: (previous?.revision ?? 0) + 1,
        })
        .onConflictDoUpdate({
          target: [authors.instanceId, authors.actorId],
          set: { status, reason, retryAt, revision: (previous?.revision ?? 0) + 1 },
        });
      if (status === 'revoked' && ctx.config.mode === 'qualified') {
        const rows = await tx
          .update(submissions)
          .set({
            status: 'ended',
            reason: `作問者資格取消：${reason}`,
            revision: sql`${submissions.revision} + 1`,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              scope,
              eq(submissions.authorId, target),
              inArray(submissions.status, ['pending', 'returned']),
            ),
          )
          .returning();
        for (const row of rows) await audit(tx, row, actorId, 'eligibility-ended');
      }
      if (operation === 'author-decision')
        await notify(
          tx,
          instanceId,
          target,
          `作問者資格：${status === 'qualified' ? '承認' : status === 'revoked' ? '取消' : '不承認'}。${reason}${retryAt ? ` 再申請可能日時：${retryAt}` : ''}`,
          { page: 'qualification' },
        );
      return { ok: true };
    }
    if (operation === 'settings') {
      requireAdministrator(ctx.account);
      if ((ctx.configuration?.revision ?? 0) !== input.revision)
        fail('EDIT_CONFLICT', 409);
      const config = input.config as QuestionSettings;
      if (
        !config ||
        !submissionModes.includes(config.mode) ||
        !Number.isInteger(config.authorWaitDays) ||
        config.authorWaitDays < 0 ||
        config.authorWaitDays > 3650 ||
        typeof config.showAuthor !== 'boolean' ||
        !Number.isInteger(config.reportThreshold) ||
        config.reportThreshold < 1 ||
        !Number.isInteger(config.categoryReportThreshold) ||
        config.categoryReportThreshold < 1
      )
        fail('INVALID_SETTINGS', 400);
      if (
        config.rankBoundaries &&
        (!Array.isArray(config.rankBoundaries) ||
          config.rankBoundaries.length !== 2 ||
          !config.rankBoundaries.every(Number.isFinite) ||
          config.rankBoundaries[0] >= config.rankBoundaries[1])
      )
        fail('INVALID_SETTINGS', 400);
      if (
        config.difficultyWeights &&
        (!Array.isArray(config.difficultyWeights) ||
          config.difficultyWeights.length !== 3 ||
          config.difficultyWeights.some(
            (weights, band) =>
              !Array.isArray(weights) ||
              weights.length !== 3 ||
              weights.some(
                (weight, level) =>
                  !Number.isFinite(weight) ||
                  weight < 0 ||
                  (level > band && weight !== 0),
              ) ||
              weights.reduce((sum, weight) => sum + weight, 0) <= 0,
          ))
      )
        fail('INVALID_SETTINGS', 400);
      if (config.categoryWeights) {
        const available = await tx
          .select()
          .from(categories)
          .where(eq(categories.instanceId, instanceId));
        if (
          typeof config.categoryWeights !== 'object' ||
          Array.isArray(config.categoryWeights) ||
          Object.entries(config.categoryWeights).some(
            ([id, weight]) =>
              !available.some((category) => category.id === id) ||
              !Number.isFinite(weight) ||
              weight < 0,
          )
        )
          fail('INVALID_SETTINGS', 400);
      }
      const rows = await tx
        .select()
        .from(submissions)
        .where(
          and(
            scope,
            isNull(submissions.deletedAt),
            inArray(submissions.status, ['pending', 'returned']),
          ),
        );
      for (const row of rows) {
        const [author] = await tx
          .select()
          .from(authors)
          .where(
            and(eq(authors.instanceId, instanceId), eq(authors.actorId, row.authorId)),
          );
        const [account] = await tx
          .select()
          .from(organizationAccounts)
          .where(eq(organizationAccounts.actorId, row.authorId));
        if (
          !canSubmitQuestion(
            config.mode,
            account.administrator,
            author?.status === 'qualified',
          )
        ) {
          const [updated] = await tx
            .update(submissions)
            .set({
              status: 'ended',
              reason: '投稿方式の変更により審査を終了しました。',
              revision: row.revision + 1,
            })
            .where(eq(submissions.id, row.id))
            .returning();
          await audit(tx, updated, actorId, 'eligibility-ended');
          await notify(tx, instanceId, row.authorId, updated.reason, {
            page: 'edit',
            id: row.id,
          });
        } else if (config.mode === 'open' && row.status === 'pending') {
          await checkedInput(tx, instanceId, row.input, true);
          const publishedId = await publish(tx, ctx, { ...row, reviewHold: false });
          const [updated] = await tx
            .update(submissions)
            .set({
              status: 'approved',
              reviewHold: false,
              publishedId,
              revision: row.revision + 1,
            })
            .where(eq(submissions.id, row.id))
            .returning();
          await audit(tx, updated, actorId, 'automatic-approval');
          await notify(
            tx,
            instanceId,
            row.authorId,
            '審査なし方式への変更により、提出済み問題が出題可能になりました。',
            { page: 'edit', id: row.id },
          );
        }
      }
      await tx
        .insert(settings)
        .values({ instanceId, config, revision: (ctx.configuration?.revision ?? 0) + 1 })
        .onConflictDoUpdate({
          target: settings.instanceId,
          set: { config, revision: (ctx.configuration?.revision ?? 0) + 1 },
        });
      await publishQuestionCatalog(tx, instanceId, ctx.instance.owner, profile);
      return { ok: true };
    }
    if (operation === 'save' || operation === 'import') {
      if (
        !input.id &&
        !canSubmitQuestion(
          ctx.config.mode,
          ctx.account.administrator,
          ctx.author?.status === 'qualified',
        )
      )
        fail('SUBMISSION_FORBIDDEN');
      if (operation === 'import') {
        const requestId = validId(input.requestId);
        if (typeof input.source === 'string') {
          try {
            input.questions = parseQuestionJson(input.source);
          } catch (error) {
            throw new QuestionError('INVALID_IMPORT', 400, [
              {
                path: 'JSON',
                message:
                  error instanceof Error ? error.message : 'JSONを確認してください。',
              },
            ]);
          }
        }
        if (
          !Array.isArray(input.questions) ||
          input.questions.length < 1 ||
          input.questions.length > 500 ||
          new TextEncoder().encode(
            JSON.stringify({ version: 1, questions: input.questions }),
          ).length > 2000000
        )
          fail('INVALID_IMPORT', 400);
        const hash = await contentHash(input.questions);
        const [previous] = await tx
          .select()
          .from(imports)
          .where(
            and(
              eq(imports.instanceId, instanceId),
              eq(imports.actorId, actorId),
              eq(imports.requestId, requestId),
            ),
          );
        if (previous) {
          if (previous.hash !== hash) fail('EDIT_CONFLICT', 409);
          return { ids: previous.ids };
        }
        const ids: string[] = [];
        const importedQuestions = input.questions as unknown[];
        for (let index = 0; index < importedQuestions.length; index++) {
          let value: QuestionInput;
          try {
            value = await checkedInput(tx, instanceId, importedQuestions[index], false);
          } catch (error) {
            if (error instanceof QuestionError)
              error.issues.forEach((issue) => {
                issue.path = `questions.${index}.${issue.path}`;
              });
            throw error;
          }
          const id = crypto.randomUUID();
          const [row] = await tx
            .insert(submissions)
            .values({
              id,
              instanceId,
              seriesId: id,
              authorId: actorId,
              authorName,
              input: value,
            })
            .returning();
          await audit(tx, row, actorId, 'import');
          ids.push(id);
        }
        await tx.insert(imports).values({ instanceId, actorId, requestId, hash, ids });
        return { ids };
      }
      const value = await checkedInput(tx, instanceId, input.input, false);
      if (!input.id) {
        const id = crypto.randomUUID();
        const [row] = await tx
          .insert(submissions)
          .values({
            id,
            instanceId,
            seriesId: id,
            authorId: actorId,
            authorName,
            input: value,
          })
          .returning();
        await audit(tx, row, actorId, 'save');
        return { id };
      }
      const [row] = await tx
        .select()
        .from(submissions)
        .where(
          and(
            scope,
            eq(submissions.id, validId(input.id)),
            eq(submissions.authorId, actorId),
          ),
        );
      if (!row) fail('QUESTION_NOT_FOUND', 404);
      if (
        row.revision !== input.revision ||
        row.deletedAt ||
        row.status === 'pending' ||
        row.status === 'rejected'
      )
        fail('EDIT_CONFLICT', 409);
      const [updated] = await tx
        .update(submissions)
        .set({
          input: value,
          status: row.status === 'returned' ? 'returned' : 'draft',
          authorName,
          revision: row.revision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(submissions.id, row.id))
        .returning();
      await audit(tx, updated, actorId, 'save');
      return { id: row.id };
    }
    const [row] = await tx
      .select()
      .from(submissions)
      .where(and(scope, eq(submissions.id, validId(input.id))));
    if (!row || (!ctx.review && row.authorId !== actorId))
      fail('QUESTION_NOT_FOUND', 404);
    if (row.revision !== input.revision) fail('EDIT_CONFLICT', 409);
    if (row.deletedAt && operation !== 'restore') fail('QUESTION_DELETED', 409);
    const patch: Partial<typeof submissions.$inferInsert> = {
      revision: row.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (operation === 'submit') {
      if (
        row.authorId !== actorId ||
        !canSubmitQuestion(
          ctx.config.mode,
          ctx.account.administrator,
          ctx.author?.status === 'qualified',
        )
      )
        fail('SUBMISSION_FORBIDDEN');
      if (!['draft', 'returned', 'ended'].includes(row.status))
        fail('EDIT_CONFLICT', 409);
      await checkedInput(tx, instanceId, row.input, true);
      patch.status = ctx.config.mode === 'open' ? 'approved' : 'pending';
      patch.reason = '';
      if (patch.status === 'approved') {
        patch.reviewHold = false;
        patch.publishedId = await publish(tx, ctx, { ...row, reviewHold: false });
      }
    } else if (operation === 'withdraw') {
      if (row.authorId !== actorId) fail('SUBMISSION_FORBIDDEN');
      if (row.status !== 'pending') fail('EDIT_CONFLICT', 409);
      patch.status = 'draft';
    } else if (
      operation === 'approve' ||
      operation === 'return' ||
      operation === 'reject'
    ) {
      if (
        !canReviewQuestion(ctx.account.administrator, ctx.review, row.authorId, actorId)
      )
        fail('REVIEW_FORBIDDEN');
      if (row.status !== 'pending' && !(operation === 'return' && row.publishedId))
        fail('EDIT_CONFLICT', 409);
      const [author] = await tx
        .select()
        .from(authors)
        .where(
          and(eq(authors.instanceId, instanceId), eq(authors.actorId, row.authorId)),
        );
      const [account] = await tx
        .select()
        .from(organizationAccounts)
        .where(eq(organizationAccounts.actorId, row.authorId));
      if (
        !canSubmitQuestion(
          ctx.config.mode,
          account.administrator,
          author?.status === 'qualified',
        )
      )
        fail('SUBMISSION_FORBIDDEN');
      patch.reason = reasonFor(input, operation !== 'approve');
      patch.status =
        operation === 'approve'
          ? 'approved'
          : operation === 'return'
            ? 'returned'
            : 'rejected';
      if (operation === 'approve') {
        await checkedInput(tx, instanceId, row.input, true);
        patch.reviewHold = false;
        patch.publishedId = await publish(tx, ctx, { ...row, reviewHold: false });
      }
      if (operation === 'return') {
        patch.reviewHold = true;
        if (row.publishedId)
          await tx
            .update(questionAvailability)
            .set({ retiredAt: new Date().toISOString() })
            .where(
              and(
                eq(questionAvailability.owner, ctx.instance.owner),
                eq(questionAvailability.questionId, row.publishedId),
              ),
            );
      }
      await notify(
        tx,
        instanceId,
        row.authorId,
        `問題「${row.input.text}」：${operation === 'approve' ? '承認' : operation === 'return' ? '差戻し' : '却下'}。${patch.reason}`,
        { page: 'edit', id: row.id },
      );
    } else if (operation === 'delete' || operation === 'restore') {
      if (!ctx.review) fail('REVIEW_FORBIDDEN');
      if (operation === 'restore' && !row.deletedAt) fail('EDIT_CONFLICT', 409);
      patch.deletedAt = operation === 'delete' ? new Date().toISOString() : null;
      patch.reason = reasonFor(input);
      if (row.publishedId)
        await tx
          .update(questionAvailability)
          .set({
            retiredAt:
              patch.deletedAt ||
              (row.stopped || row.reviewHold ? new Date().toISOString() : null),
          })
          .where(
            and(
              eq(questionAvailability.owner, ctx.instance.owner),
              eq(questionAvailability.questionId, row.publishedId),
            ),
          );
    } else if (operation === 'stop' || operation === 'resume') {
      if (!ctx.review) fail('REVIEW_FORBIDDEN');
      patch.stopped = operation === 'stop';
      patch.reason = reasonFor(input);
      if (row.publishedId)
        await tx
          .update(questionAvailability)
          .set({
            retiredAt: patch.stopped || row.reviewHold ? new Date().toISOString() : null,
          })
          .where(
            and(
              eq(questionAvailability.owner, ctx.instance.owner),
              eq(questionAvailability.questionId, row.publishedId),
            ),
          );
    } else fail('INVALID_OPERATION', 400);
    const [updated] = await tx
      .update(submissions)
      .set(patch)
      .where(eq(submissions.id, row.id))
      .returning();
    await audit(tx, updated, actorId, String(operation));
    if (
      patch.publishedId ||
      ['stop', 'resume', 'return', 'delete', 'restore'].includes(String(operation))
    )
      await publishQuestionCatalog(tx, instanceId, ctx.instance.owner, profile);
    return { id: row.id };
  });
}
