import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { parseQuestionJson } from '../../shared/question-json.ts';
import { parseTransfer, type TransferQuestion } from '../../shared/question-transfer.ts';
import {
  canReviewQuestion,
  canSubmitQuestion,
  normalizeTag,
  type QuestionInput,
  type QuestionSettings,
  submissionModes,
} from '../../shared/questions.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, type D1Write, type Database } from '../db/d1.ts';
import {
  federationQuestionImports,
  federationQuestionLinks,
  moderationRequests,
  organizationAccounts,
  type questionAuthors,
  questionImports,
  questionNotifications,
  questionReports,
  questionReviewCases,
  questionSubmissionEvents,
  questionSubmissions,
  questionVersions,
} from '../db/schema.ts';
import { requireAdministrator, validId } from '../organization/access.ts';
import { requireUnrestricted } from '../organization/moderation.ts';
import type { ResultRecord } from '../results/record.ts';
import { publishQuestionCatalog } from './catalog.ts';
import { QuestionError } from './error.ts';
import { QuestionPlan } from './plan.ts';
import { questionContext } from './read.ts';

const fail = (code: string, status: 400 | 403 | 404 | 409 = 403): never => {
  throw new QuestionError(code, status);
};
function reasonFor(input: Record<string, unknown>, required = true) {
  if (
    typeof input.reason !== 'string' ||
    input.reason.length > 1000 ||
    (required && !input.reason.trim())
  )
    return fail('REASON_REQUIRED', 400);
  return input.reason.trim();
}

export async function recordQuestionReport(
  db: Database,
  writes: D1Write[],
  instanceId: string,
  actorId: string,
  input: Record<string, unknown>,
  observedQuestion?: { id: string },
) {
  if (!observedQuestion || observedQuestion.id !== input.questionId)
    throw new QuestionError('QUESTION_NOT_FOUND', 404);
  if (input.kind !== 'defect' && input.kind !== 'category')
    return fail('INVALID_REPORT', 400);
  const kind = input.kind;
  const reason = reasonFor(input);
  const suggestedCategory =
    typeof input.suggestedCategory === 'string' ? input.suggestedCategory.trim() : '';
  if (suggestedCategory.length > 80) fail('INVALID_REPORT', 400);
  const [latest] = await db
    .select()
    .from(questionReviewCases)
    .where(
      and(
        eq(questionReviewCases.instanceId, instanceId),
        eq(questionReviewCases.questionId, observedQuestion.id),
        eq(questionReviewCases.kind, kind),
      ),
    )
    .orderBy(desc(questionReviewCases.round))
    .limit(1);
  const round = latest ? latest.round + (latest.resolved ? 1 : 0) : 1;
  const [previous] = await db
    .select()
    .from(questionReports)
    .where(
      and(
        eq(questionReports.instanceId, instanceId),
        eq(questionReports.questionId, observedQuestion.id),
        eq(questionReports.kind, kind),
        eq(questionReports.round, round),
        eq(questionReports.actorId, actorId),
      ),
    );
  if (previous) fail('ALREADY_REPORTED', 409);
  writes.push(
    db.insert(questionReports).values({
      id: crypto.randomUUID(),
      instanceId,
      questionId: observedQuestion.id,
      kind,
      round,
      actorId,
      reason,
      suggestedCategory,
    }),
    db
      .insert(questionReviewCases)
      .values({ instanceId, questionId: observedQuestion.id, kind, round, count: 1 })
      .onConflictDoUpdate({
        target: [
          questionReviewCases.instanceId,
          questionReviewCases.questionId,
          questionReviewCases.kind,
          questionReviewCases.round,
        ],
        set: { count: sql`${questionReviewCases.count} + 1` },
      }),
  );
  return { ok: true as const };
}

function validateSettings(config: QuestionSettings, plan: QuestionPlan) {
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
              !Number.isFinite(weight) || weight < 0 || (level > band && weight !== 0),
          ) ||
          weights.reduce((sum, weight) => sum + weight, 0) <= 0,
      ))
  )
    fail('INVALID_SETTINGS', 400);
  if (
    config.categoryWeights &&
    (typeof config.categoryWeights !== 'object' ||
      Array.isArray(config.categoryWeights) ||
      Object.entries(config.categoryWeights).some(
        ([id, weight]) =>
          !plan.categories.has(id) || !Number.isFinite(weight) || weight < 0,
      ))
  )
    fail('INVALID_SETTINGS', 400);
}

export async function questionMutation(
  db: Database,
  subject: string,
  instanceId: string,
  request: Record<string, unknown>,
  profile = 'local',
  observedQuestion?: NonNullable<ResultRecord['completedQuestions']>[number],
  authorName = '作問者',
) {
  validId(instanceId);
  return changeD1(db, async (writes) => {
    const ctx = await questionContext(db, subject, instanceId);
    const actorId = ctx.account.actorId;
    const plan = new QuestionPlan(instanceId, ctx.instance.owner);
    await plan.load(db, request);
    const sharedRows = await db
      .select({
        id: federationQuestionLinks.submissionId,
        purgedAt: federationQuestionLinks.cachePurgedAt,
      })
      .from(federationQuestionLinks)
      .where(
        and(
          eq(federationQuestionLinks.instanceId, instanceId),
          sql`${federationQuestionLinks.submissionId} in (select value from json_each(${JSON.stringify([...plan.submissions.keys()])}))`,
        ),
      );
    const sharedIds = new Set(sharedRows.map((row) => row.id));
    const purgedIds = new Set(
      sharedRows.filter((row) => row.purgedAt !== null).map((row) => row.id),
    );
    const accountIds = new Set([...plan.submissions.values()].map((row) => row.authorId));
    if (typeof request.actorId === 'string') accountIds.add(request.actorId);
    const accounts = new Map(
      (accountIds.size
        ? await db
            .select()
            .from(organizationAccounts)
            .where(
              and(
                eq(organizationAccounts.organizationId, ctx.organization.id),
                sql`${organizationAccounts.actorId} in (select value from json_each(${JSON.stringify([...accountIds])}))`,
              ),
            )
        : []
      ).map((account) => [account.actorId, account]),
    );
    const canSubmit = (id: string, config = ctx.config) => {
      const account = id === actorId ? ctx.account : accounts.get(id);
      return (
        !!account &&
        !account.withdrawnAt &&
        canSubmitQuestion(
          config.mode,
          account.administrator,
          plan.authors.get(id)?.status === 'qualified',
        )
      );
    };
    const selectedRow = (input: Record<string, unknown>) => {
      const row = plan.submissions.get(validId(input.id));
      if (!row || (!ctx.review && row.authorId !== actorId))
        return fail('QUESTION_NOT_FOUND', 404);
      if (row.revision !== input.revision) return fail('EDIT_CONFLICT', 409);
      if (purgedIds.has(row.id)) return fail('SHARED_QUESTION_EXPIRED', 409);
      if (
        sharedIds.has(row.id) &&
        !['difficulty', 'exclude-shared'].includes(String(input.operation))
      )
        return fail('SHARED_QUESTION_READ_ONLY', 403);
      if (row.deletedAt && input.operation !== 'restore')
        return fail('QUESTION_DELETED', 409);
      return row;
    };
    const receipt = async (id: string, hash: string) => {
      const [previous] = await db
        .select()
        .from(moderationRequests)
        .where(eq(moderationRequests.id, id));
      if (previous && (previous.operatorId !== actorId || previous.requestHash !== hash))
        fail('EDIT_CONFLICT', 409);
      return previous;
    };
    const saveReceipt = (id: string, hash: string, details: Record<string, unknown>) =>
      writes.push(
        db.insert(moderationRequests).values({
          id,
          organizationId: ctx.organization.id,
          operatorId: actorId,
          requestHash: hash,
          details,
        }),
      );

    async function mutate(input: Record<string, unknown>): Promise<{
      ok?: true;
      id?: string;
      ids?: string[];
      questions?: unknown[];
      history?: unknown[];
      notifications?: unknown[];
    }> {
      const operation = String(input.operation);
      if (
        ctx.instance.state === 'archived' &&
        ![
          'export',
          'export-managed',
          'notifications',
          'read-notifications',
          'history',
        ].includes(operation)
      )
        fail('INSTANCE_ARCHIVED', 409);
      if (operation === 'submit') {
        if (!ctx.account.displayName) fail('PROFILE_REQUIRED', 409);
        await requireUnrestricted(db, ctx.organization.id, actorId, instanceId, 'submit');
      }
      if (operation === 'exclude-shared') {
        if (!ctx.review) fail('REVIEW_FORBIDDEN');
        if (typeof input.excluded !== 'boolean') return fail('INVALID_CHANGES', 400);
        const row = selectedRow(input);
        if (!sharedIds.has(row.id) || !row.publishedId)
          return fail('SHARED_QUESTION_NOT_FOUND', 404);
        writes.push(
          db
            .update(federationQuestionLinks)
            .set({ excluded: input.excluded })
            .where(
              and(
                eq(federationQuestionLinks.instanceId, instanceId),
                eq(federationQuestionLinks.submissionId, row.id),
              ),
            ),
        );
        plan.save(row, { stopped: input.excluded, revision: row.revision + 1 });
        plan.retire(
          row.publishedId,
          input.excluded || row.reviewHold ? new Date().toISOString() : null,
        );
        plan.audit(row, actorId, input.excluded ? 'shared-excluded' : 'shared-restored');
        plan.catalogChanged = true;
        return { ok: true };
      }
      if (operation === 'export' || operation === 'export-managed') {
        if (operation === 'export-managed' && !ctx.review) fail('REVIEW_FORBIDDEN');
        const ids = input.ids;
        if (
          operation === 'export-managed' &&
          input.all !== true &&
          (!Array.isArray(ids) || !ids.length)
        )
          fail('INVALID_CHANGES', 400);
        const selected =
          operation === 'export'
            ? [...plan.submissions.values()].filter((row) => row.authorId === actorId)
            : input.all === true
              ? [...plan.submissions.values()].filter(
                  (row) => row.status === 'approved' && !row.deletedAt,
                )
              : (ids as unknown[]).map((id) => plan.submissions.get(validId(id)));
        if (selected.some((row) => !row)) return fail('QUESTION_NOT_FOUND', 404);
        const rows = selected
          .filter((row) => !!row)
          .filter((row) => !sharedIds.has(row.id))
          .sort((left, right) => left.id.localeCompare(right.id));
        if (operation === 'export') return { questions: rows.map((row) => row.input) };
        return {
          questions: rows.map(
            (row) =>
              ({
                input: row.input,
                category: plan.categories.get(row.input.categoryId)?.name ?? '',
                stopped: row.stopped || row.reviewHold,
                provenance: row.provenance ?? {
                  author: row.authorName,
                  instance: ctx.instance.name,
                },
              }) satisfies TransferQuestion,
          ),
        };
      }
      if (operation === 'report')
        return recordQuestionReport(
          db,
          writes,
          instanceId,
          actorId,
          input,
          observedQuestion,
        );
      if (operation === 'resolve-report') {
        if (!ctx.review) fail('REVIEW_FORBIDDEN');
        const reason = reasonFor(input);
        if (input.kind !== 'defect' && input.kind !== 'category')
          return fail('INVALID_REPORT', 400);
        const filter = and(
          eq(questionReviewCases.instanceId, instanceId),
          eq(questionReviewCases.questionId, String(input.questionId)),
          eq(questionReviewCases.kind, input.kind),
          eq(questionReviewCases.round, Number(input.round)),
          eq(questionReviewCases.resolved, false),
        );
        const [reviewCase] = await db.select().from(questionReviewCases).where(filter);
        if (!reviewCase) fail('EDIT_CONFLICT', 409);
        writes.push(
          db
            .update(questionReviewCases)
            .set({ resolved: true, reason, resolvedAt: new Date().toISOString() })
            .where(filter),
        );
        const [version] = await db
          .select()
          .from(questionVersions)
          .where(
            and(
              eq(questionVersions.owner, ctx.instance.owner),
              eq(questionVersions.questionId, String(input.questionId)),
            ),
          );
        if (version?.payload.seriesId) {
          const [row] = await db
            .select()
            .from(questionSubmissions)
            .where(
              and(
                eq(questionSubmissions.instanceId, instanceId),
                eq(questionSubmissions.seriesId, version.payload.seriesId),
              ),
            );
          if (row)
            plan.notify(row.authorId, `問題の再審議が解決しました：${reason}`, {
              page: 'edit',
              id: row.id,
            });
        }
        return { ok: true };
      }
      if (operation === 'notifications')
        return {
          notifications: await db
            .select()
            .from(questionNotifications)
            .where(
              and(
                eq(questionNotifications.instanceId, instanceId),
                eq(questionNotifications.actorId, actorId),
                sql`${questionNotifications.createdAt} > ${new Date(Date.now() - 90 * 86400000).toISOString()}`,
              ),
            )
            .orderBy(desc(questionNotifications.createdAt))
            .limit(5),
        };
      if (operation === 'read-notifications') {
        if (!Array.isArray(input.ids) || input.ids.length > 5)
          fail('INVALID_OPERATION', 400);
        const ids = (input.ids as unknown[]).map(validId);
        if (ids.length)
          writes.push(
            db
              .update(questionNotifications)
              .set({ read: true })
              .where(
                and(
                  eq(questionNotifications.instanceId, instanceId),
                  eq(questionNotifications.actorId, actorId),
                  sql`${questionNotifications.id} in (select value from json_each(${JSON.stringify(ids)}))`,
                ),
              ),
          );
        return { ok: true };
      }
      if (operation === 'history') {
        const row = plan.submissions.get(validId(input.id));
        if (!row || (!ctx.review && row.authorId !== actorId))
          return fail('QUESTION_NOT_FOUND', 404);
        const history = await db
          .select()
          .from(questionSubmissionEvents)
          .where(
            and(
              eq(questionSubmissionEvents.instanceId, instanceId),
              eq(questionSubmissionEvents.submissionId, row.id),
            ),
          )
          .orderBy(asc(questionSubmissionEvents.createdAt));
        return {
          history: history.map(({ actorId: reviewer, ...event }) => ({
            ...event,
            ...(ctx.review ? { actorId: reviewer } : {}),
          })),
        };
      }
      if (
        ctx.instance.state !== 'published' &&
        !ctx.account.administrator &&
        !ctx.permissions.length
      )
        fail('INSTANCE_PREPARING');
      if (operation === 'bulk') {
        if (!ctx.review) fail('REVIEW_FORBIDDEN');
        const id = validId(input.requestId),
          hash = await contentHash({ instanceId, input });
        if (await receipt(id, hash)) return { ok: true };
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
            'exclude-shared',
          ].includes(String(input.action)) ||
          !Array.isArray(input.changes) ||
          !input.changes.length ||
          input.changes.length > 500 ||
          (['approve', 'reject'].includes(String(input.action)) &&
            input.changes.length !== 1)
        )
          fail('INVALID_CHANGES', 400);
        const changes = input.changes as { id: string; revision: number }[];
        if (new Set(changes.map((change) => change.id)).size !== changes.length)
          fail('DUPLICATE_QUESTION', 400);
        for (const change of changes) {
          try {
            await mutate({
              ...input,
              ...change,
              operation: input.action,
              changes: [change],
            });
          } catch (error) {
            if (error instanceof QuestionError)
              error.issues.push({
                path:
                  plan.submissions.get(validId(change.id))?.input.text || '選択した問題',
                message: error.code,
              });
            throw error;
          }
        }
        saveReceipt(id, hash, {
          instanceId,
          action: input.action,
          ids: changes.map((change) => change.id),
        });
        return { ok: true };
      }
      if (operation === 'category') {
        requireAdministrator(ctx.account);
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name || name.length > 80) fail('INVALID_NAME', 400);
        if (
          [...plan.categories.values()].some(
            (category) => category.name === name && category.id !== input.id,
          )
        )
          fail('EDIT_CONFLICT', 409);
        const id = input.id ? validId(input.id) : crypto.randomUUID();
        const before = plan.categories.get(id);
        if (input.id && (!before || before.revision !== input.revision))
          fail('EDIT_CONFLICT', 409);
        if (input.active === false) {
          const destination = plan.categories.get(validId(input.destination));
          if (
            !destination?.active ||
            destination.id === id ||
            (destination.importOnly &&
              [...plan.submissions.values()].some(
                (row) => row.input.categoryId === id && !sharedIds.has(row.id),
              ))
          )
            return fail('INVALID_CATEGORY', 400);
          writes.push(
            db
              .update(federationQuestionImports)
              .set({
                config: sql`json_set(${federationQuestionImports.config},'$.targetCategoryId',${destination.id})`,
                revision: sql`${federationQuestionImports.revision}+1`,
                activeSnapshot: null,
                snapshot: null,
                cursor: null,
                attemptId: null,
                leaseUntil: 0,
                nextAttemptAt: 0,
              })
              .where(
                and(
                  eq(federationQuestionImports.instanceId, instanceId),
                  sql`json_extract(${federationQuestionImports.config},'$.targetCategoryId')=${id}`,
                ),
              ),
          );
          for (const row of [...plan.submissions.values()]) {
            let updated = row;
            if (
              row.publishedId &&
              plan.versions.get(row.publishedId)?.payload.categoryId === id
            )
              updated = plan.metadata(row, { categoryId: destination.id });
            if (row.input.categoryId === id) {
              updated = plan.save(updated, {
                input: { ...row.input, categoryId: destination.id },
                revision: row.revision + 1,
              });
              plan.audit(updated, actorId, 'category-move');
            }
          }
        }
        const row = {
          id,
          instanceId,
          name,
          active: input.active !== false,
          importOnly: before?.importOnly ?? false,
          revision: (before?.revision ?? 0) + 1,
        };
        plan.categories.set(id, row);
        plan.changedCategories.set(id, row);
        if (input.active === false) plan.catalogChanged = true;
        return { ok: true, id };
      }
      if (operation === 'request-category' || operation === 'reject-category') {
        const row = selectedRow(input);
        if (operation === 'request-category' ? row.authorId !== actorId : !ctx.review)
          fail('QUESTION_NOT_FOUND', 404);
        const reason = reasonFor(input, operation === 'reject-category');
        if (operation === 'request-category') {
          const category = plan.categories.get(validId(input.categoryId));
          if (!category?.active || category.importOnly)
            return fail('INVALID_CATEGORY', 400);
          plan.audit(
            { ...row, input: { ...row.input, categoryId: category.id }, reason },
            actorId,
            'category-request',
          );
        } else {
          plan.audit({ ...row, reason }, actorId, 'category-rejected');
          plan.notify(row.authorId, `カテゴリ変更申請を見送りました：${reason}`, {
            page: 'edit',
            id: row.id,
          });
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
          let row = selectedRow({ ...change, operation });
          let value = row.input;
          if (operation === 'classify') {
            const category = plan.categories.get(validId(change.categoryId));
            if (!category?.active || category.importOnly)
              return fail('INVALID_CATEGORY', 400);
            value = { ...value, categoryId: category.id };
            row = plan.metadata(row, { categoryId: category.id });
          } else {
            if (
              ![0, 1, 2].includes(Number(change.difficulty)) ||
              typeof change.fixed !== 'boolean'
            )
              return fail('INVALID_DIFFICULTY', 400);
            value = { ...value, difficulty: Number(change.difficulty) };
            row = plan.metadata(row, { difficulty: value.difficulty });
            const old = plan.difficulty.get(row.seriesId);
            const current = {
              instanceId,
              seriesId: row.seriesId,
              generation: old?.generation ?? row.seriesId,
              current: value.difficulty,
              fixed: change.fixed,
              reason: reasonFor(input),
              revision: (old?.revision ?? 0) + 1,
              stats: old?.stats ?? [],
              lastDay: old?.lastDay ?? null,
              statisticsRevision: old?.statisticsRevision ?? 0,
              cursor: old?.cursor ?? null,
            };
            plan.difficulty.set(row.seriesId, current);
            plan.changedDifficulty.set(row.seriesId, current);
          }
          row = plan.save(row, { input: value, revision: row.revision + 1 });
          plan.audit(row, actorId, operation);
        }
        plan.catalogChanged = true;
        return { ok: true };
      }
      if (operation === 'merge-tags') {
        if (!ctx.review) fail('REVIEW_FORBIDDEN');
        const from = normalizeTag(String(input.from ?? '')),
          to = normalizeTag(String(input.to ?? ''));
        if (!from || !to || from === to) fail('INVALID_TAG', 400);
        const source = plan.tags.get(from),
          target = plan.tags.get(to);
        if (!source || !target) return fail('INVALID_TAG', 400);
        const mergedKeys = [...plan.tags.values()]
          .filter((tag) => tag.name === source.name || tag.name === target.name)
          .map((tag) => tag.key);
        const aliases = [...new Set([...source.aliases, source.name, ...target.aliases])];
        for (const key of mergedKeys) {
          const tag = plan.tags.get(key);
          if (tag) {
            const updated = { ...tag, name: target.name, aliases };
            plan.tags.set(key, updated);
            plan.changedTags.set(key, updated);
          }
        }
        for (const row of plan.submissions.values()) {
          const names = row.input.tags.map((name) =>
            mergedKeys.includes(normalizeTag(name)) ? target.name : name,
          );
          if (JSON.stringify(names) !== JSON.stringify(row.input.tags))
            plan.audit(
              plan.save(row, {
                input: { ...row.input, tags: [...new Set(names)] },
                revision: row.revision + 1,
              }),
              actorId,
              'merge-tags',
            );
        }
        return { ok: true };
      }
      if (operation === 'author-request' || operation === 'author-decision') {
        const target = operation === 'author-request' ? actorId : String(input.actorId);
        if (operation === 'author-decision' && !ctx.manageAuthors)
          fail('AUTHOR_PERMISSION_REQUIRED');
        const account = target === actorId ? ctx.account : accounts.get(target);
        if (!account) fail('ACCOUNT_NOT_FOUND', 404);
        if (account?.withdrawnAt) fail('ACCOUNT_WITHDRAWN', 409);
        const previous = plan.authors.get(target);
        const reason = reasonFor(
          input,
          operation === 'author-decision' && input.decision !== 'qualified',
        );
        if (
          operation === 'author-request' &&
          (previous?.status === 'pending' ||
            previous?.status === 'qualified' ||
            (previous?.retryAt && Date.parse(previous.retryAt) > Date.now()))
        )
          fail('AUTHOR_REQUEST_UNAVAILABLE', 409);
        if (
          operation === 'author-decision' &&
          (!['qualified', 'rejected', 'revoked'].includes(String(input.decision)) ||
            (previous?.revision ?? 0) !== input.revision)
        )
          fail('EDIT_CONFLICT', 409);
        const status =
          operation === 'author-request'
            ? 'pending'
            : (input.decision as 'qualified' | 'rejected' | 'revoked');
        const retryAt =
          status === 'rejected'
            ? new Date(Date.now() + ctx.config.authorWaitDays * 86400000).toISOString()
            : null;
        const author: typeof questionAuthors.$inferSelect = {
          instanceId,
          actorId: target,
          status,
          reason,
          retryAt,
          revision: (previous?.revision ?? 0) + 1,
        };
        plan.authors.set(target, author);
        plan.changedAuthors.set(target, author);
        if (status === 'revoked' && ctx.config.mode === 'qualified')
          for (const row of plan.submissions.values()) {
            if (row.authorId === target && ['pending', 'returned'].includes(row.status))
              plan.audit(
                plan.save(row, {
                  status: 'ended',
                  reason: `作問者資格取消：${reason}`,
                  revision: row.revision + 1,
                  updatedAt: new Date().toISOString(),
                }),
                actorId,
                'eligibility-ended',
              );
          }
        if (operation === 'author-decision')
          plan.notify(
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
        validateSettings(config, plan);
        for (const row of [...plan.submissions.values()]) {
          if (row.deletedAt || !['pending', 'returned'].includes(row.status)) continue;
          if (!canSubmit(row.authorId, config)) {
            const updated = plan.save(row, {
              status: 'ended',
              reason: '投稿方式の変更により審査を終了しました。',
              revision: row.revision + 1,
            });
            plan.audit(updated, actorId, 'eligibility-ended');
            plan.notify(row.authorId, updated.reason, { page: 'edit', id: row.id });
          } else if (config.mode === 'open' && row.status === 'pending') {
            plan.checkedInput(row.input, true);
            const publishedId = await plan.publish({ ...row, reviewHold: false });
            const updated = plan.save(row, {
              status: 'approved',
              reviewHold: false,
              publishedId,
              revision: row.revision + 1,
            });
            plan.audit(updated, actorId, 'automatic-approval');
            plan.notify(
              row.authorId,
              '審査なし方式への変更により、提出済み問題が出題可能になりました。',
              { page: 'edit', id: row.id },
            );
          }
        }
        plan.configuration = {
          instanceId,
          config,
          revision: (ctx.configuration?.revision ?? 0) + 1,
        };
        plan.catalogChanged = true;
        return { ok: true };
      }
      if (operation === 'import-transfer') {
        if (!canSubmit(actorId)) fail('SUBMISSION_FORBIDDEN');
        const id = validId(input.requestId),
          hash = await contentHash({ instanceId, input });
        if (await receipt(id, hash)) return { ok: true };
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
        for (const name of new Set(portable.map((question) => question.category))) {
          const destination = mapping[name];
          if (!destination) fail('INVALID_CATEGORY', 400);
          if (destination.name) {
            const created = await mutate({
              operation: 'category',
              name: destination.name,
            });
            if (!created.id) return fail('INVALID_CATEGORY', 400);
            mapped.set(name, created.id);
          } else {
            const category = plan.categories.get(validId(destination.id));
            if (!category?.active || category.importOnly)
              return fail('INVALID_CATEGORY', 400);
            mapped.set(name, category.id);
          }
        }
        for (const portableQuestion of portable) {
          const value = plan.checkedInput(
            {
              ...portableQuestion.input,
              categoryId: mapped.get(portableQuestion.category),
            },
            false,
          );
          plan.audit(
            plan.draft(actorId, portableQuestion.provenance.author, value, {
              provenance: portableQuestion.provenance,
              stopped: portableQuestion.stopped,
            }),
            actorId,
            'import',
          );
        }
        saveReceipt(id, hash, { instanceId, operation });
        return { ok: true };
      }
      if (operation === 'save' || operation === 'import') {
        if (!input.id && !canSubmit(actorId)) fail('SUBMISSION_FORBIDDEN');
        if (operation === 'import') {
          const requestId = validId(input.requestId);
          let values: unknown = input.questions;
          if (typeof input.source === 'string') {
            try {
              values = parseQuestionJson(input.source);
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
            !Array.isArray(values) ||
            !values.length ||
            values.length > 500 ||
            new TextEncoder().encode(JSON.stringify({ version: 1, questions: values }))
              .length > 2000000
          )
            return fail('INVALID_IMPORT', 400);
          const hash = await contentHash(values);
          const [previous] = await db
            .select()
            .from(questionImports)
            .where(
              and(
                eq(questionImports.instanceId, instanceId),
                eq(questionImports.actorId, actorId),
                eq(questionImports.requestId, requestId),
              ),
            );
          if (previous) {
            if (previous.hash !== hash) fail('EDIT_CONFLICT', 409);
            return { ids: previous.ids };
          }
          const ids: string[] = [];
          for (let index = 0; index < values.length; index++) {
            let value: QuestionInput;
            try {
              value = plan.checkedInput(values[index], false);
            } catch (error) {
              if (error instanceof QuestionError)
                for (const issue of error.issues)
                  issue.path = `questions.${index}.${issue.path}`;
              throw error;
            }
            const row = plan.draft(actorId, ctx.account.displayName ?? authorName, value);
            plan.audit(row, actorId, 'import');
            ids.push(row.id);
          }
          writes.push(
            db
              .insert(questionImports)
              .values({ instanceId, actorId, requestId, hash, ids }),
          );
          return { ids };
        }
        const value = plan.checkedInput(input.input, false);
        if (!input.id) {
          const row = plan.draft(actorId, ctx.account.displayName ?? authorName, value);
          plan.audit(row, actorId, 'save');
          return { id: row.id };
        }
        const row = selectedRow(input);
        if (row.authorId !== actorId) fail('QUESTION_NOT_FOUND', 404);
        if (row.status === 'pending' || row.status === 'rejected')
          fail('EDIT_CONFLICT', 409);
        plan.audit(
          plan.save(row, {
            input: value,
            status: row.status === 'returned' ? 'returned' : 'draft',
            authorName: ctx.account.displayName ?? authorName,
            revision: row.revision + 1,
            updatedAt: new Date().toISOString(),
          }),
          actorId,
          'save',
        );
        return { id: row.id };
      }
      const row = selectedRow(input);
      const patch: Partial<typeof questionSubmissions.$inferSelect> = {
        revision: row.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (operation === 'submit') {
        if (row.authorId !== actorId || !canSubmit(actorId)) fail('SUBMISSION_FORBIDDEN');
        if (!['draft', 'returned', 'ended'].includes(row.status))
          fail('EDIT_CONFLICT', 409);
        plan.checkedInput(row.input, true);
        patch.status = ctx.config.mode === 'open' ? 'approved' : 'pending';
        patch.reason = '';
        if (patch.status === 'approved') {
          patch.reviewHold = false;
          patch.publishedId = await plan.publish({ ...row, reviewHold: false });
        }
      } else if (operation === 'withdraw') {
        if (row.authorId !== actorId) fail('SUBMISSION_FORBIDDEN');
        if (row.status !== 'pending') fail('EDIT_CONFLICT', 409);
        patch.status = 'draft';
      } else if (['approve', 'return', 'reject'].includes(operation)) {
        if (
          !canReviewQuestion(ctx.account.administrator, ctx.review, row.authorId, actorId)
        )
          fail('REVIEW_FORBIDDEN');
        if (row.status !== 'pending' && !(operation === 'return' && row.publishedId))
          fail('EDIT_CONFLICT', 409);
        if (!canSubmit(row.authorId)) fail('SUBMISSION_FORBIDDEN');
        patch.reason = reasonFor(input, operation !== 'approve');
        patch.status =
          operation === 'approve'
            ? 'approved'
            : operation === 'return'
              ? 'returned'
              : 'rejected';
        if (operation === 'approve') {
          plan.checkedInput(row.input, true);
          patch.reviewHold = false;
          patch.publishedId = await plan.publish({ ...row, reviewHold: false });
        }
        if (operation === 'return') {
          patch.reviewHold = true;
          if (row.publishedId) plan.retire(row.publishedId, new Date().toISOString());
        }
        plan.notify(
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
          plan.retire(
            row.publishedId,
            patch.deletedAt ||
              (row.stopped || row.reviewHold ? new Date().toISOString() : null),
          );
      } else if (operation === 'stop' || operation === 'resume') {
        if (!ctx.review) fail('REVIEW_FORBIDDEN');
        patch.stopped = operation === 'stop';
        patch.reason = reasonFor(input);
        if (row.publishedId)
          plan.retire(
            row.publishedId,
            patch.stopped || row.reviewHold ? new Date().toISOString() : null,
          );
      } else fail('INVALID_OPERATION', 400);
      plan.audit(plan.save(row, patch), actorId, operation);
      return { id: row.id };
    }

    const result = await mutate(request);
    // Receipts with submission FKs must follow their domain rows in the same batch.
    const receipts = writes.splice(0);
    plan.flush(writes);
    writes.push(...receipts);
    if (plan.catalogChanged)
      await publishQuestionCatalog(
        db,
        writes,
        instanceId,
        ctx.instance.owner,
        profile,
        undefined,
        {
          submissions: [...plan.changedSubmissions.values()],
          questions: plan.newVersions,
          availability: [...plan.availability.values()],
          configuration: plan.configuration,
        },
      );
    return result;
  });
}
