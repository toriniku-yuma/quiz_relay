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
import {
  defaultQuestionSettings,
  normalizeTag,
  type QuestionListQuery,
  type QuestionOverview,
  type QuestionView,
  questionPageSizes,
  questionViews,
  statusLabels,
} from '../../shared/questions.ts';
import { compareValues, questionSortKeys, sortInput } from '../../shared/sorting.ts';
import { type Database, readD1 } from '../db/d1.ts';
import {
  questionAuthors as authors,
  questionReviewCases as cases,
  questionCategories as categories,
  questionDifficulty as difficulty,
  questionSubmissionEvents as events,
  federationQuestionLinks,
  matchResults,
  questionNotifications as notifications,
  organizationAccounts,
  questionVersions,
  questionReports as reports,
  questionSettings as settings,
  questionSubmissions as submissions,
  questionTags as tags,
} from '../db/schema.ts';
import { orderValue } from '../db/sorting.ts';
import { requireAdministrator, validId } from '../organization/access.ts';
import { resolveInstance } from '../organization/database.ts';
import { readDifficultyStatistics } from './difficulty-statistics.ts';

export { QuestionError } from './error.ts';

import { QuestionError } from './error.ts';

const fail = (code: string, status: 400 | 403 | 404 | 409 = 403): never => {
  throw new QuestionError(code, status);
};

export async function questionContext(db: Database, subject: string, instanceId: string) {
  const resolved = await resolveInstance(db, subject, instanceId, true);
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
    input.shared !== undefined &&
    !['all', 'local', 'shared', 'excluded'].includes(String(input.shared))
  )
    fail('INVALID_QUERY', 400);
  if (input.sourceInstanceId) validId(input.sourceInstanceId);
  if (input.sourceCategory) validId(input.sourceCategory);
  if (
    input.peerOrigin !== undefined &&
    (typeof input.peerOrigin !== 'string' || input.peerOrigin.length > 2048)
  )
    fail('INVALID_QUERY', 400);
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
): Promise<QuestionOverview> {
  const ctx = await questionContext(db, subject, instanceId);
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
  const text = submissions.searchText;
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
    list?.shared === 'local'
      ? sql`not exists(select 1 from ${federationQuestionLinks} link where link.submission_id=${submissions.id})`
      : undefined,
    list?.shared === 'shared' ||
      list?.shared === 'excluded' ||
      list?.sourceInstanceId ||
      list?.sourceCategory
      ? sql`exists(select 1 from ${federationQuestionLinks} link where link.submission_id=${submissions.id}
          ${list.shared === 'excluded' ? sql`and link.excluded=1` : sql``}
          ${list.sourceInstanceId ? sql`and link.source_instance_id=${list.sourceInstanceId}` : sql``}
          ${list.peerOrigin ? sql`and link.peer_origin=${list.peerOrigin}` : sql``}
          ${list.sourceCategory ? sql`and json_extract(link.source_category,'$.id')=${list.sourceCategory}` : sql``})`
      : undefined,
    list?.query
      ? or(
          sql`instr(${text}, ${list.query}) > 0`,
          sql`exists(select 1 from json_each(${submissions.input}, '$.tags') tag join json_each(${JSON.stringify(matchingTags)}) known on known.value=tag.value)`,
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
    status: sql`json_extract(${JSON.stringify(statusLabels)}, '$.' || ${submissions.status}) || case when ${submissions.stopped} then '・使用停止中' else '' end`,
    category: sql`(select name from quiz_game_question_categories where id = ${submissions.input}->>'categoryId' and instance_id = ${instanceId})`,
    author: sql`coalesce(${submissions.provenance}->>'author', (select display_name from quiz_game_organization_accounts where actor_id = ${submissions.authorId}))`,
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
  if (levels.length) {
    const groups = await readDifficultyStatistics(
      db,
      ctx.instance.owner,
      levels.map((level) => level.generation),
    );
    for (const level of levels) level.stats = groups.get(level.generation) ?? [];
  }
  const reviewCases =
    ctx.review && (list || needs('reports'))
      ? await db.select().from(cases).where(eq(cases.instanceId, instanceId))
      : [];
  const reportedOriginals: NonNullable<QuestionOverview['reportedOriginals']> = {};
  if (
    ctx.review &&
    needs('reports') &&
    reviewCases.some((reviewCase) => reviewCase.questionId.startsWith('original-'))
  ) {
    const reported = new Set(reviewCases.map((reviewCase) => reviewCase.questionId));
    const originals = await db
      .select({ payload: matchResults.payload })
      .from(matchResults)
      .where(
        and(
          eq(matchResults.owner, ctx.instance.owner),
          sql`${matchResults.finishedAt} > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')`,
          sql`json_extract(${matchResults.payload},'$.definition.original')=1`,
          sql`exists(select 1 from json_each(${matchResults.payload},'$.completedQuestions') question join json_each(${JSON.stringify([...reported])}) reported on reported.value=json_extract(question.value,'$.id'))`,
        ),
      );
    for (const { payload: record } of originals) {
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
              sql`${events.submissionId} in (select value from json_each(${JSON.stringify(rows.map((row) => row.id))}))`,
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
  const shared = new Map(
    (rows.length
      ? await db
          .select({
            id: federationQuestionLinks.submissionId,
            purged: federationQuestionLinks.cachePurgedAt,
            excluded: federationQuestionLinks.excluded,
            peerOrigin: federationQuestionLinks.peerOrigin,
            sourceInstanceId: federationQuestionLinks.sourceInstanceId,
            sourceCategory: federationQuestionLinks.sourceCategory,
          })
          .from(federationQuestionLinks)
          .where(
            and(
              eq(federationQuestionLinks.instanceId, instanceId),
              sql`${federationQuestionLinks.submissionId} in (select value from json_each(${JSON.stringify(rows.map((row) => row.id))}))`,
            ),
          )
      : []
    ).map((row) => [row.id, row]),
  );
  for (const event of categoryEvents)
    if (!latestCategory.has(event.submissionId))
      latestCategory.set(event.submissionId, event);
  return {
    ...(list && ctx.review
      ? {
          sharedSourceCategories: [
            ...new Map(
              (
                await db
                  .select({
                    peerOrigin: federationQuestionLinks.peerOrigin,
                    instanceId: federationQuestionLinks.sourceInstanceId,
                    category: federationQuestionLinks.sourceCategory,
                  })
                  .from(federationQuestionLinks)
                  .where(eq(federationQuestionLinks.instanceId, instanceId))
                  .groupBy(
                    federationQuestionLinks.peerOrigin,
                    federationQuestionLinks.sourceInstanceId,
                    federationQuestionLinks.sourceCategory,
                  )
                  .orderBy(sql`max(${federationQuestionLinks.lastAvailableAt})`)
              ).map(({ category, ...source }) => [
                `${source.peerOrigin}|${source.instanceId}|${category.id}`,
                { ...source, ...category },
              ]),
            ).values(),
          ],
          sharedSources: await db
            .select({
              peerOrigin: federationQuestionLinks.peerOrigin,
              instanceId: federationQuestionLinks.sourceInstanceId,
              name: sql<string>`coalesce(json_extract(${submissions.provenance},'$.instance'),${federationQuestionLinks.peerOrigin})`,
            })
            .from(federationQuestionLinks)
            .innerJoin(
              submissions,
              eq(submissions.id, federationQuestionLinks.submissionId),
            )
            .where(eq(federationQuestionLinks.instanceId, instanceId))
            .groupBy(
              federationQuestionLinks.peerOrigin,
              federationQuestionLinks.sourceInstanceId,
            ),
        }
      : {}),
    authorNames: Object.fromEntries(
      (rows.length
        ? await db
            .select({
              id: organizationAccounts.actorId,
              name: sql<string>`case when ${organizationAccounts.withdrawnAt} is not null then '退会ユーザー' else ${organizationAccounts.displayName} end`,
            })
            .from(organizationAccounts)
            .where(
              sql`${organizationAccounts.actorId} in (select value from json_each(${JSON.stringify(rows.map((submission) => submission.authorId))}))`,
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
    submissions: rows.map((row) => ({
      ...row,
      metrics: metrics.get(row.id),
      ...(shared.has(row.id)
        ? {
            shared: {
              excluded: shared.get(row.id)?.excluded,
              peerOrigin: shared.get(row.id)?.peerOrigin,
              sourceInstanceId: shared.get(row.id)?.sourceInstanceId,
              sourceCategory: shared.get(row.id)?.sourceCategory,
              expired: shared.get(row.id)?.purged !== null,
            },
          }
        : {}),
    })),
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
                sql`${notifications.createdAt} > ${new Date(Date.now() - 90 * 86400000).toISOString()}`,
              ),
            )
            .orderBy(desc(notifications.createdAt))
            .limit(100),
  };
}

export async function questionOverview(
  db: Database,
  subject: string,
  instanceId: string,
  input?: unknown,
  viewInput?: unknown,
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
  return readD1(db, () => readQuestionOverview(db, subject, instanceId, list, view));
}
