import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type {
  SharedQuestion,
  SharedQuestionPage,
} from '../../shared/federation-questions.ts';
import { contentHash } from '../catalog/hash.ts';
import type { Database } from '../db/d1.ts';
import {
  federationPolicies,
  federationQuestionLinks,
  instances,
  organizationAccounts,
  questionAvailability,
  questionCategories,
  questionSubmissions,
  questionVersions,
} from '../db/schema.ts';
import { OrganizationError, validId } from '../organization/access.ts';

export async function exportSharedQuestions(
  db: Database,
  peerOrigin: string,
  value: unknown,
): Promise<SharedQuestionPage> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('INVALID_QUESTION_SYNC', 400);
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'sourceInstanceId',
          'targetInstanceId',
          'cursor',
          'snapshot',
          'categoriesOnly',
        ].includes(key),
    )
  )
    throw new OrganizationError('INVALID_QUESTION_SYNC', 400);
  const sourceInstanceId = validId(input.sourceInstanceId),
    targetInstanceId = validId(input.targetInstanceId),
    cursor = input.cursor === undefined ? undefined : validId(input.cursor);
  if (
    input.snapshot !== undefined &&
    (typeof input.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(input.snapshot))
  )
    throw new OrganizationError('INVALID_QUESTION_SYNC', 400);
  if (cursor && !input.snapshot)
    throw new OrganizationError('INVALID_QUESTION_SYNC', 400);
  if (input.categoriesOnly !== undefined && input.categoriesOnly !== true)
    throw new OrganizationError('INVALID_QUESTION_SYNC', 400);
  const sourceOwner = db
    .select({ owner: instances.owner })
    .from(instances)
    .where(eq(instances.id, sourceInstanceId));
  const sourceQuery = db
    .select()
    .from(instances)
    .where(eq(instances.id, sourceInstanceId));
  const policyQuery = db
    .select()
    .from(federationPolicies)
    .where(
      and(
        eq(federationPolicies.instanceId, sourceInstanceId),
        eq(federationPolicies.peerOrigin, peerOrigin),
        eq(federationPolicies.peerInstanceId, targetInstanceId),
      ),
    );
  const categoriesQuery = db
    .select({
      id: questionCategories.id,
      name: questionCategories.name,
      revision: questionCategories.revision,
    })
    .from(questionCategories)
    .where(
      and(
        eq(questionCategories.instanceId, sourceInstanceId),
        eq(questionCategories.active, true),
        eq(questionCategories.importOnly, false),
      ),
    )
    .orderBy(questionCategories.id);
  if (input.categoriesOnly) {
    const [[source], [policy], categories] = await db.batch([
      sourceQuery,
      policyQuery,
      categoriesQuery,
    ]);
    if (source?.state !== 'published' || !policy?.permissions.send.questions)
      throw new OrganizationError('QUESTION_SHARING_DENIED', 403);
    return {
      categories: categories.map(({ id, name }) => ({ id, name })),
      sourceInstanceId,
      targetInstanceId,
      sourceName: source.name,
      snapshot: '',
      questions: [],
      nextCursor: null,
    };
  }
  const joins = db
    .select({
      seriesId: questionSubmissions.seriesId,
      authorId: questionSubmissions.authorId,
      authorName: questionSubmissions.authorName,
      input: questionSubmissions.input,
      question: questionVersions.payload,
      categoryId: questionCategories.id,
      categoryName: questionCategories.name,
      withdrawnAt: organizationAccounts.withdrawnAt,
    })
    .from(questionSubmissions)
    .innerJoin(
      questionVersions,
      and(
        inArray(questionVersions.owner, sourceOwner),
        eq(questionVersions.questionId, questionSubmissions.publishedId),
      ),
    )
    .innerJoin(
      questionAvailability,
      and(
        inArray(questionAvailability.owner, sourceOwner),
        eq(questionAvailability.questionId, questionVersions.questionId),
      ),
    )
    .innerJoin(
      questionCategories,
      eq(
        questionCategories.id,
        sql`json_extract(${questionVersions.payload}, '$.categoryId')`,
      ),
    )
    .innerJoin(
      organizationAccounts,
      eq(organizationAccounts.actorId, questionSubmissions.authorId),
    )
    .leftJoin(
      federationQuestionLinks,
      eq(federationQuestionLinks.submissionId, questionSubmissions.id),
    )
    .where(
      and(
        eq(questionSubmissions.instanceId, sourceInstanceId),
        isNull(questionSubmissions.deletedAt),
        isNull(questionAvailability.retiredAt),
        eq(questionCategories.active, true),
        eq(questionCategories.importOnly, false),
        isNull(federationQuestionLinks.submissionId),
        cursor ? gt(questionSubmissions.seriesId, cursor) : undefined,
      ),
    );
  // Only publication and sharing facts contribute; transport nonces never invalidate a page.
  const factsQuery = db
    .select({
      facts: sql<string>`coalesce(json_group_array(json_array(${questionSubmissions.id},${questionSubmissions.publishedId},${questionSubmissions.revision},${questionSubmissions.authorName},${questionAvailability.retiredAt},${organizationAccounts.withdrawnAt})), '[]')`,
    })
    .from(questionSubmissions)
    .leftJoin(
      questionAvailability,
      and(
        inArray(questionAvailability.owner, sourceOwner),
        eq(questionAvailability.questionId, questionSubmissions.publishedId),
      ),
    )
    .innerJoin(
      organizationAccounts,
      eq(organizationAccounts.actorId, questionSubmissions.authorId),
    )
    .leftJoin(
      federationQuestionLinks,
      eq(federationQuestionLinks.submissionId, questionSubmissions.id),
    )
    .where(
      and(
        eq(questionSubmissions.instanceId, sourceInstanceId),
        isNull(federationQuestionLinks.submissionId),
      ),
    );
  // One batch keeps authorization, publication facts and page contents consistent.
  const [[source], [policy], categories, page, [facts]] = await db.batch([
    sourceQuery,
    policyQuery,
    categoriesQuery,
    joins.orderBy(asc(questionSubmissions.seriesId)).limit(26),
    factsQuery,
  ]);
  if (source?.state !== 'published' || !policy?.permissions.send.questions)
    throw new OrganizationError('QUESTION_SHARING_DENIED', 403);
  const snapshot = await contentHash({
    source: source.operationRevision,
    policy: policy.revision,
    categories,
    facts: facts.facts,
  });
  if (input.snapshot && input.snapshot !== snapshot)
    throw new OrganizationError('QUESTION_SNAPSHOT_CHANGED', 409);
  const questions: SharedQuestion[] = [];
  for (const row of page.slice(0, 25)) {
    const { question } = row;
    const content = {
      seriesId: row.seriesId,
      questionId: question.id,
      authorId: row.authorId,
      authorName: row.withdrawnAt ? '退会ユーザー' : row.authorName,
      category: { id: row.categoryId, name: row.categoryName },
      input: {
        ...row.input,
        categoryId: row.categoryId,
        text: question.text,
        displayAnswer: question.displayAnswer ?? question.answer,
        readings: question.readings ?? [question.answer],
        traps: question.traps ?? [],
        explanation: question.explanation,
        source: question.source,
        evidence: '共有元で確認済み',
        difficulty: question.difficulty ?? 0,
      },
    };
    questions.push({ ...content, hash: await contentHash(content) });
  }
  return {
    sourceInstanceId,
    targetInstanceId,
    sourceName: source.name,
    snapshot,
    categories: categories.map(({ id, name }) => ({ id, name })),
    questions,
    nextCursor: page.length > 25 ? page[24].seriesId : null,
  };
}
