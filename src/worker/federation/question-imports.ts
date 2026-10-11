import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { API_PATHS } from '../../shared/api-paths.ts';
import {
  QUESTION_SYNC_INTERVAL_MS,
  type SharedQuestionPage,
} from '../../shared/federation-questions.ts';
import { validateQuestionInput } from '../../shared/questions.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, rowsD1 } from '../db/d1.ts';
import {
  federationActors,
  federationDeletedInstances,
  federationPeers,
  federationPolicies,
  federationQuestionImports,
  federationQuestionLinks,
  federationQuestionStaging,
  federationRetiredIdentities,
  instances,
  organizationAccounts,
  organizations,
  questionCategories,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import {
  actorForSubject,
  OrganizationError,
  validId,
  validName,
} from '../organization/access.ts';
import { publishQuestionCatalog } from '../questions/catalog.ts';
import { QuestionPlan } from '../questions/plan.ts';
import { exportSharedQuestions } from './question-source.ts';
import { federationDatabase, requestPeer } from './transport.ts';

type Import = typeof federationQuestionImports.$inferSelect;
async function parsedPage(value: unknown, job: Import): Promise<SharedQuestionPage> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('INVALID_SHARED_QUESTIONS', 503);
  const page = value as SharedQuestionPage;
  if (
    Object.keys(page).sort().join(',') !==
      'categories,nextCursor,questions,snapshot,sourceInstanceId,sourceName,targetInstanceId' ||
    page.sourceInstanceId !== job.sourceInstanceId ||
    page.targetInstanceId !== job.instanceId ||
    !/^[a-f0-9]{64}$/.test(page.snapshot) ||
    !Array.isArray(page.questions) ||
    page.questions.length > 25 ||
    !Array.isArray(page.categories) ||
    page.categories.length > 1000
  )
    throw new OrganizationError('INVALID_SHARED_QUESTIONS', 503);
  validName(page.sourceName);
  if (page.nextCursor !== null) validId(page.nextCursor);
  for (const category of page.categories) {
    if (Object.keys(category).sort().join(',') !== 'id,name')
      throw new OrganizationError('INVALID_SHARED_QUESTIONS', 503);
    validId(category.id);
    validName(category.name);
  }
  for (const question of page.questions) {
    if (
      !question ||
      Object.keys(question).sort().join(',') !==
        'authorId,authorName,category,hash,input,questionId,seriesId' ||
      !/^[a-f0-9]{64}$/.test(question.authorId) ||
      !/^[a-f0-9]{64}$/.test(question.hash) ||
      Object.keys(question.category).sort().join(',') !== 'id,name' ||
      !page.categories.some(
        (category) =>
          category.id === question.category.id &&
          category.name === question.category.name,
      ) ||
      !Number.isSafeInteger(question.input?.difficulty) ||
      ![0, 1, 2].includes(question.input.difficulty) ||
      validateQuestionInput(question.input).issues.length
    )
      throw new OrganizationError('INVALID_SHARED_QUESTIONS', 503);
    validId(question.seriesId);
    validId(question.questionId);
    validName(question.authorName);
    const { hash, ...content } = question;
    if (
      hash !== (await contentHash(content)) ||
      question.input.categoryId !== question.category.id
    )
      throw new OrganizationError('INVALID_SHARED_QUESTIONS', 503);
  }
  if (
    new Set(page.questions.map((question) => question.seriesId)).size !==
      page.questions.length ||
    new Set(page.categories.map((category) => category.id)).size !==
      page.categories.length ||
    (job.snapshot && job.snapshot !== page.snapshot)
  )
    throw new OrganizationError('QUESTION_SNAPSHOT_CHANGED', 409);
  const after = job.cursor && !job.cursor.startsWith('apply') ? job.cursor : '';
  if (
    page.questions.some(
      (question, index) =>
        question.seriesId <= (index ? page.questions[index - 1].seriesId : after),
    ) ||
    (page.nextCursor !== null &&
      (page.questions.length !== 25 ||
        page.nextCursor !== page.questions.at(-1)?.seriesId))
  )
    throw new OrganizationError('INVALID_SHARED_QUESTIONS', 503);
  return page;
}
async function importAllowed(env: Env, job: Import) {
  const db = federationDatabase(env);
  const [row] = await db
    .select({
      instance: instances,
      policy: federationPolicies,
      peer: federationPeers,
      deleted:
        sql<number>`exists(select 1 from ${federationDeletedInstances} where ${federationDeletedInstances.peerOrigin}=${job.peerOrigin} and ${federationDeletedInstances.instanceId}=${job.sourceInstanceId})`.mapWith(
          Number,
        ),
    })
    .from(instances)
    .innerJoin(
      federationPolicies,
      and(
        eq(federationPolicies.instanceId, job.instanceId),
        eq(federationPolicies.peerOrigin, job.peerOrigin),
        eq(federationPolicies.peerInstanceId, job.sourceInstanceId),
      ),
    )
    .innerJoin(federationPeers, eq(federationPeers.origin, job.peerOrigin))
    .innerJoin(
      questionCategories,
      and(
        eq(questionCategories.id, job.config.targetCategoryId),
        eq(questionCategories.instanceId, job.instanceId),
        eq(questionCategories.active, true),
      ),
    )
    .where(eq(instances.id, job.instanceId));
  if (
    !job.enabled ||
    !row ||
    row.instance.state === 'archived' ||
    row.deleted ||
    !row.policy.permissions.receive.questions ||
    !row.peer.approved
  )
    throw new OrganizationError('QUESTION_IMPORT_DENIED', 403);
  return row.instance;
}
export async function syncQuestionImport(env: Env, id: string) {
  const db = federationDatabase(env),
    attemptId = crypto.randomUUID();
  const job = await changeD1(db, async (writes) => {
    const [current] = await db
      .select()
      .from(federationQuestionImports)
      .where(eq(federationQuestionImports.id, validId(id)));
    if (!current?.enabled || current.leaseUntil > Date.now())
      throw new OrganizationError('QUESTION_SYNC_BUSY', 409);
    writes.push(
      db
        .update(federationQuestionImports)
        .set({ attemptId, leaseUntil: Date.now() + 15000 })
        .where(eq(federationQuestionImports.id, id)),
    );
    return current;
  });
  try {
    const instance = await importAllowed(env, job);
    const applying = job.cursor?.startsWith('apply:') || job.cursor === 'apply';
    const request = {
      sourceInstanceId: job.sourceInstanceId,
      targetInstanceId: job.instanceId,
      ...(job.snapshot ? { snapshot: job.snapshot } : {}),
      ...(!applying && job.cursor ? { cursor: job.cursor } : {}),
    };
    const received =
      job.peerOrigin === env.FEDERATION_ORIGIN
        ? await exportSharedQuestions(db, job.peerOrigin, request)
        : (
            await requestPeer(
              env,
              job.peerOrigin,
              API_PATHS.federationQuestionSync,
              'questions.request',
              'questions.response',
              request,
            )
          ).body;
    const page = await parsedPage(received, job);
    return await changeD1(db, async (writes) => {
      const [current] = await db
        .select()
        .from(federationQuestionImports)
        .where(eq(federationQuestionImports.id, id));
      if (current?.attemptId !== attemptId || current.revision !== job.revision)
        throw new OrganizationError('QUESTION_IMPORT_CONFLICT', 409);
      await importAllowed(env, current);
      const key = and(
        eq(federationQuestionImports.id, id),
        eq(federationQuestionImports.attemptId, attemptId),
      );
      if (!applying) {
        // An unchanged source needs only a fresh lease, not another copy of every page.
        if (!job.cursor && current.activeSnapshot === page.snapshot) {
          writes.push(
            db
              .update(federationQuestionImports)
              .set({
                lastSuccessAt: Date.now(),
                errorCode: null,
                failures: 0,
                snapshot: null,
                cursor: null,
                attemptId: null,
                leaseUntil: 0,
                nextAttemptAt: Date.now() + QUESTION_SYNC_INTERVAL_MS,
              })
              .where(key),
          );
          return { ok: true, pending: false };
        }
        const selected = page.questions.filter(
          (question) =>
            !job.config.categories.length ||
            job.config.categories.includes(question.category.id),
        );
        const staged = selected.length
          ? await db
              .select()
              .from(federationQuestionStaging)
              .where(
                and(
                  eq(federationQuestionStaging.importId, id),
                  eq(federationQuestionStaging.snapshot, page.snapshot),
                  sql`${federationQuestionStaging.seriesId} in (select value from json_each(${JSON.stringify(selected.map((question) => question.seriesId))}))`,
                ),
              )
          : [];
        if (
          staged.some(
            (row) =>
              selected.find((question) => question.seriesId === row.seriesId)?.hash !==
              row.payload.hash,
          )
        )
          throw new OrganizationError('QUESTION_SNAPSHOT_CHANGED', 409);
        if (selected.length)
          writes.push(
            rowsD1(
              federationQuestionStaging,
              selected.map((question) => ({
                importId: id,
                snapshot: page.snapshot,
                seriesId: question.seriesId,
                payload: question,
                createdAt: Date.now(),
              })),
              'ignore',
            ),
          );
        writes.push(
          db
            .update(federationQuestionImports)
            .set({
              snapshot: page.snapshot,
              cursor: page.nextCursor ?? 'apply',
              errorCode: null,
              leaseUntil: 0,
              attemptId: null,
              nextAttemptAt: 0,
            })
            .where(key),
        );
        return { ok: true, pending: true };
      }
      const cursor = job.cursor?.startsWith('apply:') ? job.cursor.slice(6) : null;
      const staged = await db
        .select()
        .from(federationQuestionStaging)
        .where(
          and(
            eq(federationQuestionStaging.importId, id),
            eq(federationQuestionStaging.snapshot, page.snapshot),
            cursor ? gt(federationQuestionStaging.seriesId, cursor) : undefined,
          ),
        )
        .orderBy(federationQuestionStaging.seriesId)
        .limit(25);
      const links = await db
        .select()
        .from(federationQuestionLinks)
        .where(
          and(
            eq(federationQuestionLinks.instanceId, job.instanceId),
            eq(federationQuestionLinks.peerOrigin, job.peerOrigin),
            eq(federationQuestionLinks.sourceInstanceId, job.sourceInstanceId),
            sql`${federationQuestionLinks.sourceSeriesId} in (select value from json_each(${JSON.stringify(staged.map((row) => row.seriesId))}))`,
          ),
        );
      const previousImports = links.some((link) => link.importId !== id)
        ? await db
            .select()
            .from(federationQuestionImports)
            .where(
              and(
                eq(federationQuestionImports.instanceId, job.instanceId),
                eq(federationQuestionImports.peerOrigin, job.peerOrigin),
                eq(federationQuestionImports.sourceInstanceId, job.sourceInstanceId),
              ),
            )
        : [];
      for (const link of links.filter((link) => link.importId !== id)) {
        const previous = previousImports.find((row) => row.id === link.importId);
        if (
          previous &&
          (!previous.config.categories.length ||
            previous.config.categories.includes(link.sourceCategory.id))
        )
          throw new OrganizationError('QUESTION_IMPORT_OVERLAP', 409);
      }
      const plan = new QuestionPlan(job.instanceId, instance.owner);
      const mappingHash = await contentHash({
        difficulty: { '0': 0, '1': 1, '2': 2 },
        fallback: 0,
      });
      await plan.load(db, {
        operation: 'shared-sync',
        ids: links.map((link) => link.submissionId),
      });
      const retired = await db
        .select()
        .from(federationRetiredIdentities)
        .where(
          and(
            eq(federationRetiredIdentities.peerOrigin, job.peerOrigin),
            sql`${federationRetiredIdentities.actorId} in (select value from json_each(${JSON.stringify(staged.map((row) => row.payload.authorId))}))`,
          ),
        );
      const retiredIds = new Set(retired.map((actor) => actor.actorId));
      const [organization] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, instance.organizationId));
      if (!organization) throw new OrganizationError('SETUP_REQUIRED', 409);
      const accounts: (typeof organizationAccounts.$inferInsert)[] = [],
        actors: (typeof federationActors.$inferInsert)[] = [],
        updatedLinks: (typeof federationQuestionLinks.$inferInsert)[] = [];
      for (const { payload: question } of staged) {
        const link = links.find((row) => row.sourceSeriesId === question.seriesId);
        const nativeAuthor = job.peerOrigin === env.FEDERATION_ORIGIN;
        const authorId = nativeAuthor
          ? question.authorId
          : await actorForSubject(
              organization.identityNamespace,
              `federation:${job.peerOrigin}:${question.authorId}`,
            );
        const authorName = retiredIds.has(question.authorId)
          ? '退会ユーザー'
          : question.authorName;
        if (!nativeAuthor) {
          accounts.push({
            actorId: authorId,
            organizationId: instance.organizationId,
            subject: `federation:${job.peerOrigin}:${question.authorId}`,
            withdrawnAt: retiredIds.has(question.authorId)
              ? new Date().toISOString()
              : null,
          });
          actors.push({
            actorId: authorId,
            peerOrigin: job.peerOrigin,
            sourceActorId: question.authorId,
            displayName: authorName,
          });
        }
        let row = link ? plan.submissions.get(link.submissionId) : undefined;
        const mapped = question.input.difficulty;
        const input = {
          ...question.input,
          categoryId: job.config.targetCategoryId,
          difficulty: mapped,
          tags: [
            ...question.input.tags.slice(0, 9),
            `元:${Array.from(question.category.name).slice(0, 29).join('')}`,
          ],
        };
        if (!row)
          row = plan.draft(authorId, authorName, input, {
            status: 'approved',
            provenance: { author: authorName, instance: page.sourceName },
            stopped: link?.excluded ?? false,
          });
        const mappingChanged = link?.mappingRevision !== job.revision;
        if (!link || link.sourceHash !== question.hash || mappingChanged) {
          const level = plan.difficulty.get(row.seriesId);
          if (link?.mappingHash !== mappingHash && level && !level.fixed)
            plan.difficulty.set(row.seriesId, { ...level, current: mapped });
          row = plan.save(row, {
            input,
            authorName,
            provenance: { author: authorName, instance: page.sourceName },
            revision: row.revision + 1,
          });
          row = plan.save(row, {
            publishedId: await plan.publish(row, {
              peerOrigin: job.peerOrigin,
              instanceId: job.sourceInstanceId,
              questionId: question.questionId,
              seriesId: question.seriesId,
              authorId,
            }),
          });
          plan.audit(row, 'system:federation', 'shared-sync');
          plan.catalogChanged = true;
        }
        updatedLinks.push({
          instanceId: job.instanceId,
          peerOrigin: job.peerOrigin,
          sourceInstanceId: job.sourceInstanceId,
          sourceSeriesId: question.seriesId,
          importId: id,
          submissionId: row.id,
          sourceQuestionId: question.questionId,
          sourceHash: question.hash,
          sourceCategory: question.category,
          sourceDifficulty: question.input.difficulty,
          sourceAuthorId: question.authorId,
          seenSnapshot: page.snapshot,
          excluded: link?.excluded ?? false,
          mappingRevision: job.revision,
          mappingHash,
          lastAvailableAt: Date.now(),
          cachePurgedAt: null,
        });
      }
      if (accounts.length)
        writes.push(
          rowsD1(
            organizationAccounts,
            [...new Map(accounts.map((account) => [account.actorId, account])).values()],
            'ignore',
          ),
          rowsD1(
            federationActors,
            [...new Map(actors.map((actor) => [actor.actorId, actor])).values()],
            'ignore',
          ),
        );
      plan.flush(writes);
      if (updatedLinks.length)
        writes.push(rowsD1(federationQuestionLinks, updatedLinks, true));
      if (plan.catalogChanged)
        await publishQuestionCatalog(
          db,
          writes,
          job.instanceId,
          instance.owner,
          env.GAME_CONFIG_PROFILE,
          undefined,
          {
            submissions: [...plan.changedSubmissions.values()],
            questions: plan.newVersions,
            availability: [...plan.availability.values()],
          },
        );
      const pending = staged.length === 25;
      if (!pending)
        writes.push(
          db
            .delete(federationQuestionStaging)
            .where(eq(federationQuestionStaging.importId, id)),
        );
      writes.push(
        db
          .update(federationQuestionImports)
          .set({
            cursor: pending ? `apply:${staged[staged.length - 1].seriesId}` : null,
            snapshot: pending ? page.snapshot : null,
            activeSnapshot: pending ? current.activeSnapshot : page.snapshot,
            lastSuccessAt: pending ? current.lastSuccessAt : Date.now(),
            errorCode: null,
            failures: 0,
            attemptId: null,
            leaseUntil: 0,
            nextAttemptAt: pending ? 0 : Date.now() + QUESTION_SYNC_INTERVAL_MS,
          })
          .where(key),
      );
      return { ok: true, pending };
    });
  } catch (error) {
    await changeD1(db, async (writes) => {
      const [current] = await db
        .select()
        .from(federationQuestionImports)
        .where(eq(federationQuestionImports.id, id));
      if (current?.attemptId !== attemptId) return;
      const code =
        error instanceof OrganizationError ? error.code : 'QUESTION_SYNC_UNAVAILABLE';
      writes.push(
        db
          .update(federationQuestionImports)
          .set({
            attemptId: null,
            leaseUntil: 0,
            errorCode: code,
            snapshot: null,
            cursor: null,
            failures: current.failures + 1,
            nextAttemptAt: Math.max(
              error instanceof OrganizationError ? (error.retryAt ?? 0) : 0,
              Date.now() +
                Math.min(900000, 60000 * 2 ** Math.min(current.failures, 4)) *
                  (1 + Math.random() / 4),
            ),
          })
          .where(eq(federationQuestionImports.id, id)),
      );
    });
    throw error;
  }
}
export async function dueQuestionImports(env: Env, now: number) {
  return federationDatabase(env)
    .select({ id: federationQuestionImports.id })
    .from(federationQuestionImports)
    .where(
      and(
        eq(federationQuestionImports.enabled, true),
        lte(federationQuestionImports.nextAttemptAt, now),
        lte(federationQuestionImports.leaseUntil, now),
      ),
    )
    .orderBy(federationQuestionImports.nextAttemptAt)
    .limit(2);
}
