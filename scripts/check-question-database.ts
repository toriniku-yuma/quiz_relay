import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import {
  defaultQuestionSettings,
  emptyQuestion,
  type QuestionListQuery,
} from '../src/shared/questions.ts';
import { loadMatchDefinition } from '../src/worker/catalog/database.ts';
import * as schema from '../src/worker/db/schema.ts';
import type { Env } from '../src/worker/env.ts';
import { rules } from '../src/worker/game/rules.ts';
import { actorForSubject } from '../src/worker/organization/access.ts';
import { questionMutation, questionOverview } from '../src/worker/questions/database.ts';
import type { ResultRecord } from '../src/worker/results/record.ts';
import { verifyErasureBatches } from './check-erasure-batches.ts';
import { verifyInstanceDeletion } from './check-instance-deletion.ts';
import { verifyInstanceOperations } from './check-instance-operations.ts';
import { verifyModeration } from './check-moderation-database.ts';
import { verifyWorkflows } from './check-moderation-workflows.ts';
import { verifyProfiles } from './check-profile-database.ts';
import { verifyResultPrivacyRaces } from './check-result-privacy.ts';
import { verifyRetention } from './check-retention.ts';
import { verifyWithdrawal } from './check-withdrawal.ts';
import { verifyLocalDifficultyUpdate } from './question-local-difficulty.ts';
import { provisionLocalQuestionPermissions } from './question-local-permissions.ts';

// A fresh, password-protected loopback cluster. Never reads .dev.vars or an existing database URL.
const directory = resolve(`.wrangler/questions-qa-${Date.now()}`);
const bin = resolve('.wrangler/pg-local/pgsql/bin');
const password = Buffer.from(randomBytes(24)).toString('hex');
const port = '55439';
const run = (name: string, args: string[]) =>
  execFileSync(resolve(bin, `${name}.exe`), args, {
    windowsHide: true,
    stdio: 'ignore',
    encoding: 'utf8',
    timeout: 60000,
  });
mkdirSync(directory, { recursive: true });
const passwordFile = resolve(directory, 'password');
writeFileSync(passwordFile, password, { mode: 0o600 });
run('initdb', [
  '-D',
  resolve(directory, 'data'),
  '-U',
  'postgres',
  '-A',
  'scram-sha-256',
  '--pwfile',
  passwordFile,
  '--encoding=UTF8',
  '--locale=C',
]);
run('pg_ctl', [
  '-D',
  resolve(directory, 'data'),
  '-l',
  resolve(directory, 'server.log'),
  '-o',
  `-p ${port} -h 127.0.0.1`,
  '-w',
  'start',
]);
const address = `postgres://postgres:${password}@127.0.0.1:${port}/quiz_relay_questions_test?sslmode=disable`;
const cluster = postgres(address.replace('/quiz_relay_questions_test?', '/postgres?'), {
  ssl: false,
  max: 1,
});
let client: ReturnType<typeof postgres> | undefined;
try {
  await cluster.unsafe('CREATE DATABASE quiz_relay_questions_test');
  await cluster.unsafe('CREATE ROLE anon; CREATE ROLE authenticated');
  client = postgres(address, { ssl: false, max: 3, prepare: false });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: 'drizzle' });
  await provisionLocalQuestionPermissions(db, address);
  const organizationId = crypto.randomUUID();
  const instanceId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const namespace = `urn:uuid:${organizationId}`;
  const subjects = ['admin', 'author', 'reviewer', 'outsider'];
  const actors = await Promise.all(
    subjects.map((subject) => actorForSubject(namespace, subject)),
  );
  await db
    .insert(schema.organizations)
    .values({ id: organizationId, name: '作問検証', identityNamespace: namespace });
  await db.insert(schema.organizationAccounts).values(
    subjects.map((subject, i) => ({
      organizationId,
      subject,
      actorId: actors[i],
      administrator: i === 0,
      displayName: subject,
    })),
  );
  await db.insert(schema.instances).values(
    [instanceId, otherId].map((id) => ({
      id,
      organizationId,
      name: id,
      owner: `urn:uuid:${id}`,
      state: 'published' as const,
    })),
  );
  await db.insert(schema.instanceGrants).values([
    { instanceId, actorId: actors[2], permission: 'questions' },
    { instanceId, actorId: actors[2], permission: 'authors' },
  ]);
  // Use the real service role, including its RLS and column grants, for every workflow request.
  const mutate = (subject: string, input: Record<string, unknown>, target = instanceId) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      return questionMutation(tx, subject, target, input);
    });
  const overview = (
    subject: string,
    target = instanceId,
    list?: QuestionListQuery,
    view?: unknown,
  ) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      return questionOverview(tx, subject, target, list, view);
    });
  await mutate('admin', { operation: 'category', name: '地理' });
  const categoryId = (await overview('admin')).categories[0].id;
  const question = {
    ...emptyQuestion(),
    text: '日本で一番高い山は？',
    displayAnswer: '富士山',
    readings: ['ふじさん', 'ふじやま'],
    explanation: '標高3776m。',
    evidence: '検証用の非公開根拠',
    categoryId,
  };
  await mutate('author', { operation: 'save', input: question });
  let row = (await overview('author')).submissions[0];
  assert.equal((await overview('outsider')).submissions.length, 0);
  assert.equal((await overview('reviewer', otherId)).submissions.length, 0);
  await assert.rejects(
    mutate('outsider', { operation: 'history', id: row.id }),
    /QUESTION_NOT_FOUND/,
  );
  await assert.rejects(
    mutate('author', { operation: 'submit', id: row.id, revision: 0 }),
    /EDIT_CONFLICT/,
  );
  await mutate('author', { operation: 'submit', id: row.id, revision: row.revision });
  row = (await overview('author')).submissions[0];
  await assert.rejects(
    mutate('author', {
      operation: 'save',
      id: row.id,
      revision: row.revision,
      input: question,
    }),
    /EDIT_CONFLICT/,
  );
  await mutate('reviewer', {
    operation: 'return',
    id: row.id,
    revision: row.revision,
    reason: '根拠を補足してください。',
  });
  row = (await overview('author')).submissions[0];
  assert.equal(row.status, 'returned');
  await mutate('author', { operation: 'submit', id: row.id, revision: row.revision });
  row = (await overview('author')).submissions[0];
  const oldRevision = row.revision;
  await mutate('author', { operation: 'withdraw', id: row.id, revision: row.revision });
  await assert.rejects(
    mutate('reviewer', {
      operation: 'approve',
      id: row.id,
      revision: oldRevision,
      reason: '',
    }),
    /EDIT_CONFLICT/,
  );
  row = (await overview('author')).submissions[0];
  await mutate('author', { operation: 'submit', id: row.id, revision: row.revision });
  row = (await overview('author')).submissions[0];
  await mutate('reviewer', {
    operation: 'approve',
    id: row.id,
    revision: row.revision,
    reason: '',
  });
  row = (await overview('author')).submissions[0];
  const oldPublishedId = row.publishedId;
  assert.ok(oldPublishedId);
  const [fixed] = await db
    .select()
    .from(schema.questionVersions)
    .where(eq(schema.questionVersions.questionId, oldPublishedId));
  assert.ok(!JSON.stringify(fixed.payload).includes(question.evidence));
  await mutate('author', {
    operation: 'save',
    id: row.id,
    revision: row.revision,
    input: { ...question, text: '改訂した問題' },
  });
  const [availability] = await db
    .select()
    .from(schema.questionAvailability)
    .where(eq(schema.questionAvailability.questionId, oldPublishedId));
  assert.equal(availability.retiredAt, null);
  row = (await overview('author')).submissions[0];
  await mutate('reviewer', {
    operation: 'stop',
    id: row.id,
    revision: row.revision,
    reason: '確認中',
  });
  row = (await overview('author')).submissions[0];
  await mutate('author', { operation: 'submit', id: row.id, revision: row.revision });
  row = (await overview('author')).submissions[0];
  await mutate('reviewer', {
    operation: 'approve',
    id: row.id,
    revision: row.revision,
    reason: '',
  });
  row = (await overview('author')).submissions[0];
  assert.equal(row.stopped, true);
  assert.notEqual(row.publishedId, oldPublishedId);
  assert.equal(
    (
      await db
        .select()
        .from(schema.questionVersions)
        .where(eq(schema.questionVersions.questionId, oldPublishedId))
    )[0].payload.text,
    question.text,
  );
  await mutate('reviewer', { operation: 'save', input: question });
  const own = (await overview('reviewer')).submissions.find(
    (q) => q.authorId === actors[2],
  );
  assert.ok(own);
  await mutate('reviewer', { operation: 'submit', id: own.id, revision: own.revision });
  const pending = (await overview('reviewer')).submissions.find((q) => q.id === own.id);
  assert.ok(pending);
  await assert.rejects(
    mutate('reviewer', {
      operation: 'approve',
      id: pending.id,
      revision: pending.revision,
      reason: '',
    }),
    /REVIEW_FORBIDDEN/,
  );
  await mutate('admin', {
    operation: 'settings',
    revision: 0,
    config: { ...defaultQuestionSettings, mode: 'open' },
  });
  assert.equal(
    (await overview('reviewer')).submissions.find((q) => q.id === own.id)?.status,
    'approved',
  );
  assert.equal(
    (await overview('author')).submissions.find((q) => q.id === row.id)?.stopped,
    true,
  );
  const requestId = crypto.randomUUID();
  const source = JSON.stringify({ version: 1, questions: [question, question] });
  const firstImport = await mutate('author', { operation: 'import', requestId, source });
  const retryImport = await mutate('author', { operation: 'import', requestId, source });
  assert.deepEqual(firstImport, retryImport);
  await assert.rejects(
    mutate('author', {
      operation: 'import',
      requestId,
      source: JSON.stringify({ version: 1, questions: [question] }),
    }),
    /EDIT_CONFLICT/,
  );
  const ownHistory = await mutate('author', { operation: 'history', id: row.id });
  assert.ok(!JSON.stringify(ownHistory).includes(actors[2]));
  const before = (await overview('author')).submissions.length;
  await assert.rejects(
    mutate('author', {
      operation: 'import',
      requestId: crypto.randomUUID(),
      source: JSON.stringify({
        version: 1,
        questions: [question, { ...question, approved: true }],
      }),
    }),
    /INVALID_IMPORT/,
  );
  assert.equal((await overview('author')).submissions.length, before);
  await mutate('admin', { operation: 'category', name: '移動先' });
  const destination = (await overview('admin')).categories.find(
    (category) => category.name === '移動先',
  );
  assert.ok(destination);
  const publishedRow = (await overview('reviewer')).submissions.find(
    (item) => item.id === own.id,
  );
  assert.ok(publishedRow?.publishedId);
  const [publishedBefore] = await db
    .select()
    .from(schema.questionVersions)
    .where(eq(schema.questionVersions.questionId, publishedRow.publishedId));
  await mutate('reviewer', {
    operation: 'save',
    id: publishedRow.id,
    revision: publishedRow.revision,
    input: { ...question, text: '審査前の秘密の改訂本文' },
  });
  const editing = (await overview('reviewer')).submissions.find(
    (item) => item.id === own.id,
  );
  assert.ok(editing);
  await mutate('reviewer', {
    operation: 'classify',
    changes: [{ id: editing.id, revision: editing.revision, categoryId: destination.id }],
  });
  const classified = (await overview('reviewer')).submissions.find(
    (item) => item.id === own.id,
  );
  assert.ok(classified?.publishedId);
  const [publishedAfter] = await db
    .select()
    .from(schema.questionVersions)
    .where(eq(schema.questionVersions.questionId, classified.publishedId));
  assert.equal(publishedAfter.payload.text, publishedBefore.payload.text);
  assert.equal(publishedAfter.payload.generation, publishedBefore.payload.generation);
  assert.equal(publishedAfter.payload.categoryId, destination.id);
  await assert.rejects(
    mutate('reviewer', {
      operation: 'classify',
      changes: [
        { id: editing.id, revision: editing.revision, categoryId: destination.id },
      ],
    }),
    /EDIT_CONFLICT/,
  );
  await assert.rejects(
    mutate('reviewer', {
      operation: 'difficulty',
      reason: '権限確認',
      changes: [
        { id: classified.id, revision: classified.revision, difficulty: 2, fixed: true },
      ],
    }),
    /ADMIN/,
  );
  await mutate('admin', {
    operation: 'difficulty',
    reason: '固定確認',
    changes: [
      { id: classified.id, revision: classified.revision, difficulty: 1, fixed: true },
    ],
  });
  const currentCategory = (await overview('admin')).categories.find(
    (category) => category.id === destination.id,
  );
  assert.ok(currentCategory);
  await assert.rejects(
    mutate('admin', {
      operation: 'category',
      id: currentCategory.id,
      revision: currentCategory.revision,
      name: currentCategory.name,
      active: false,
      destination: currentCategory.id,
    }),
    /INVALID_CATEGORY/,
  );
  const draft = (await overview('author')).submissions.find(
    (item) => item.status === 'draft',
  );
  assert.ok(draft);
  const races = await Promise.allSettled(
    [1, 2].map((n) =>
      mutate('author', {
        operation: 'save',
        id: draft.id,
        revision: draft.revision,
        input: { ...draft.input, explanation: `同時編集${n}` },
      }),
    ),
  );
  assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(races.filter((result) => result.status === 'rejected').length, 1);
  const autoRow = (await overview('admin')).submissions.find(
    (item) => item.id === row.id,
  );
  assert.ok(autoRow);
  await mutate('admin', {
    operation: 'difficulty',
    reason: '日次検証の初期値',
    changes: [
      { id: autoRow.id, revision: autoRow.revision, difficulty: 0, fixed: false },
    ],
  });
  const [autoDifficulty] = await db
    .select()
    .from(schema.questionDifficulty)
    .where(eq(schema.questionDifficulty.seriesId, autoRow.seriesId));
  const settingsRevision = (await overview('admin')).settingsRevision;
  const owner = `urn:uuid:${instanceId}`;
  const ref = { owner, id: 'fixture', version: 1 };
  const records: ResultRecord[] = Array.from({ length: 50 }, (_, index) => ({
    version: 1,
    owner,
    matchId: `match-${index}`,
    kind: 'ranked',
    startedAt: 0,
    ratingVersion: 1,
    players: [],
    startingRatings: { [`p${index % 20}`]: 1000, [`p${(index + 1) % 20}`]: 1000 },
    result: {
      id: `result-${index}`,
      winnerId: null,
      reason: 'exhausted',
      finishedAt: index + 1,
    },
    definition: {
      competition: ref,
      ruleset: ref,
      questionSet: ref,
      playersPerMatch: 2,
      rules: { ...rules, showSelections: true },
      rulesHash: 'test-rules',
      manifestHash: 'test-manifest',
      selection: {
        band: 0,
        boundaries: [1200, 1600],
        weights: [1, 0, 0],
        categories: {},
        revision: settingsRevision,
      },
    },
    completedQuestions: [
      {
        id: `question-${index}`,
        text: '検証問題',
        displayAnswer: '検証',
        readings: ['けんしょう'],
        explanation: '検証',
        source: '',
        generation: autoDifficulty.generation,
        seriesId: autoRow.seriesId,
        difficulty: 0,
        correct: false,
        participants: [`p${index % 20}`, `p${(index + 1) % 20}`],
      },
    ],
  }));
  const day = Date.parse('2026-09-25T12:00:00Z');
  const daily = (now: number) =>
    verifyLocalDifficultyUpdate(db, address, {
      organizationId,
      instanceId,
      owner,
      records,
      rulesHash: 'test-rules',
      players: 2,
      now,
    });
  assert.equal(await daily(day), 1);
  assert.equal(await daily(day), 0);
  assert.equal(await daily(day + 86400000), 0);
  assert.equal(
    (
      await db
        .select()
        .from(schema.questionDifficulty)
        .where(eq(schema.questionDifficulty.seriesId, autoRow.seriesId))
    )[0].current,
    1,
  );
  const denied = (error: unknown) =>
    (error as { cause?: { code?: string } }).cause?.code === '42501';
  const revisionBeforeSubmit = (await overview('reviewer')).submissions.find(
    (item) => item.id === own.id,
  );
  assert.ok(revisionBeforeSubmit);
  await mutate('reviewer', {
    operation: 'submit',
    id: own.id,
    revision: revisionBeforeSubmit.revision,
  });
  const [fixedAfterRevision] = await db
    .select()
    .from(schema.questionDifficulty)
    .where(eq(schema.questionDifficulty.seriesId, revisionBeforeSubmit.seriesId));
  assert.equal(fixedAfterRevision.current, 1);
  assert.equal(fixedAfterRevision.fixed, true);
  const requestRow = (await overview('reviewer')).submissions.find(
    (item) => item.id === own.id,
  );
  assert.ok(requestRow);
  await mutate('reviewer', {
    operation: 'request-category',
    id: requestRow.id,
    revision: requestRow.revision,
    categoryId: destination.id,
    reason: '申請の検証',
  });
  assert.equal(
    (await overview('admin')).categoryRequests.some(
      (request) => request.submissionId === requestRow.id,
    ),
    true,
  );
  await mutate('admin', {
    operation: 'reject-category',
    id: requestRow.id,
    revision: requestRow.revision,
    reason: '現カテゴリを維持',
  });
  assert.equal(
    (await overview('admin')).categoryRequests.some(
      (request) => request.submissionId === requestRow.id,
    ),
    false,
  );
  const observed = {
    id: requestRow.publishedId ?? '',
    text: '出題済み',
    displayAnswer: '答え',
    readings: ['こたえ'],
    explanation: '解説',
    source: '',
    correct: true,
    participants: [actors[1], actors[2]],
  };
  const report = () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      return questionMutation(
        tx,
        'author',
        instanceId,
        {
          operation: 'report',
          questionId: observed.id,
          kind: 'defect',
          reason: '通報の検証',
        },
        'local',
        observed,
      );
    });
  await report();
  await assert.rejects(report(), /ALREADY_REPORTED/);
  await mutate('reviewer', {
    operation: 'resolve-report',
    questionId: observed.id,
    kind: 'defect',
    round: 1,
    reason: '内容確認済み',
  });
  await report();
  const cases = (await overview('reviewer')).reviewCases.filter(
    (entry) => entry.questionId === observed.id,
  );
  assert.equal(cases.length, 2);
  assert.equal(cases.find((entry) => entry.round === 1)?.resolved, true);
  assert.equal(cases.find((entry) => entry.round === 2)?.count, 1);
  // Exercise the automatic catalog across the legacy 100-item set boundary.
  const extra = Array.from({ length: 101 }, () => ({
    id: crypto.randomUUID(),
    seriesId: crypto.randomUUID(),
  }));
  await db.insert(schema.questionVersions).values(
    extra.map(({ id, seriesId }) => ({
      owner,
      questionId: id,
      version: 1,
      payload: { ...fixed.payload, id, seriesId, generation: id, difficulty: 0 },
    })),
  );
  await db
    .insert(schema.questionAvailability)
    .values(extra.map(({ id }) => ({ owner, questionId: id })));
  await db.insert(schema.questionSubmissions).values(
    extra.map(({ id, seriesId }) => ({
      id,
      seriesId,
      instanceId,
      authorId: actors[0],
      status: 'approved' as const,
      input: question,
      publishedId: id,
    })),
  );
  const list: QuestionListQuery = {
    scope: 'all',
    page: 1,
    pageSize: 10,
    query: '',
    category: '',
    status: '',
  };
  const allRows = (await overview('admin')).submissions;
  for (const page of [
    'new',
    'import',
    'qualification',
    'authors',
    'categories',
    'settings',
    'selection',
    'tags',
  ]) {
    const result = await overview('admin', instanceId, undefined, { page });
    assert.deepEqual(result.submissions, []);
    assert.deepEqual(result.difficulty, []);
    assert.deepEqual(result.reports, []);
    assert.deepEqual(result.reviewCases, []);
    assert.deepEqual(result.notifications, []);
  }
  const decision = await overview('admin', instanceId, undefined, {
    page: 'decision',
    id: own.id,
  });
  assert.deepEqual(
    decision.submissions.map((row) => row.id),
    [own.id],
  );
  assert.deepEqual(decision.difficulty, []);
  const ownEdit = await overview('reviewer', instanceId, undefined, {
    page: 'edit',
    id: own.id,
  });
  assert.equal(ownEdit.submissions.length, 1);
  assert.ok(ownEdit.categories.length);
  const otherRow = allRows.find((row) => row.authorId !== actors[0]);
  assert.ok(otherRow);
  assert.deepEqual(
    (await overview('admin', instanceId, undefined, { page: 'edit', id: otherRow.id }))
      .submissions,
    [],
  );
  assert.ok(
    (
      await overview('admin', instanceId, {
        scope: 'all',
        page: 1,
        pageSize: 10,
        query: '',
        status: '',
        category: '',
      })
    ).difficulty.length,
  );
  await assert.rejects(
    overview('author', instanceId, undefined, { page: 'decision', id: own.id }),
    /REVIEW_FORBIDDEN/,
  );
  await assert.rejects(
    overview('author', instanceId, undefined, { page: 'authors' }),
    /REVIEW_FORBIDDEN/,
  );
  await assert.rejects(
    overview('admin', instanceId, undefined, { page: 'unknown' }),
    /INVALID_QUERY/,
  );
  await assert.rejects(
    overview('admin', instanceId, undefined, { page: 'edit' }),
    /INVALID_QUERY/,
  );
  await assert.rejects(
    overview('admin', instanceId, list, { page: 'new' }),
    /INVALID_QUERY/,
  );
  for (const pageSize of [10, 30, 100]) {
    const ids: string[] = [];
    for (let page = 1; page <= Math.ceil(allRows.length / pageSize); page++) {
      const result = await overview('admin', instanceId, { ...list, page, pageSize });
      assert.equal(result.pagination?.total, allRows.length);
      assert.ok(result.submissions.length <= pageSize);
      ids.push(...result.submissions.map((row) => row.id));
    }
    assert.deepEqual(
      ids,
      allRows.map((row) => row.id),
    );
    assert.equal(new Set(ids).size, allRows.length);
  }
  for (const sort of ['text', 'answer', 'status', 'category', 'author', 'updatedAt']) {
    for (const direction of ['asc', 'desc'] as const) {
      const sorted = await overview('admin', instanceId, {
        ...list,
        sort,
        direction,
        pageSize: 100,
      });
      const second = await overview('admin', instanceId, {
        ...list,
        sort,
        direction,
        page: 2,
      });
      assert.deepEqual(
        second.submissions.map((r) => r.id),
        sorted.submissions.slice(10, 20).map((r) => r.id),
      );
    }
  }
  const mine = await overview('admin', instanceId, { ...list, scope: 'mine' });
  assert.equal(
    mine.pagination?.total,
    allRows.filter((row) => row.authorId === actors[0]).length,
  );
  assert.ok(mine.submissions.every((row) => row.authorId === actors[0]));
  const pendingList = await overview('admin', instanceId, { ...list, scope: 'pending' });
  assert.equal(
    pendingList.pagination?.total,
    allRows.filter((row) => row.status === 'pending').length,
  );
  assert.ok(pendingList.submissions.every((row) => row.status === 'pending'));
  const searched = await overview('admin', instanceId, {
    ...list,
    query: 'ふじさん　ふじやま',
    category: categoryId,
  });
  assert.ok((searched.pagination?.total ?? 0) >= 101);
  assert.equal(searched.submissions.length, 10);
  const empty = await overview('admin', instanceId, {
    ...list,
    query: '絶対に存在しない検証語',
    page: 999,
  });
  assert.deepEqual(empty.pagination, { page: 1, pageSize: 10, total: 0 });
  assert.equal(empty.submissions.length, 0);
  const last = await overview('admin', instanceId, { ...list, page: 999 });
  assert.equal(last.pagination?.page, Math.ceil(allRows.length / 10));
  await assert.rejects(overview('author', instanceId, list), /REVIEW_FORBIDDEN/);
  await assert.rejects(overview('reviewer', otherId, list), /REVIEW_FORBIDDEN/);
  await assert.rejects(
    overview('admin', instanceId, { ...list, pageSize: 20 }),
    /INVALID_QUERY/,
  );
  await assert.rejects(
    overview('admin', instanceId, { ...list, page: 0 }),
    /INVALID_QUERY/,
  );
  const fresh = (await overview('admin')).submissions.find((item) => item.id === own.id);
  assert.ok(fresh);
  await mutate('admin', {
    operation: 'classify',
    changes: [{ id: fresh.id, revision: fresh.revision, categoryId: destination.id }],
  });
  const loaded = await loadMatchDefinition({
    GAME_OWNER: owner,
    GAME_CONFIG_PROFILE: 'local',
    GAME_DATABASE_URL: address,
  } as Env);
  assert.equal(loaded.questions.length, 101);
  assert.equal(new Set(loaded.questions.map((question) => question.id)).size, 101);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE anon`);
      await tx.select().from(schema.questionSubmissions);
    }),
    denied,
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      await tx
        .update(schema.questionVersions)
        .set({ payload: fixed.payload })
        .where(
          and(
            eq(schema.questionVersions.owner, fixed.owner),
            eq(schema.questionVersions.questionId, fixed.questionId),
          ),
        );
    }),
    denied,
  );
  // Opening the notification window marks only the displayed IDs for this account/instance.
  const noticeIds: string[] = Array.from({ length: 7 }, () => crypto.randomUUID());
  await db.insert(schema.questionNotifications).values(
    noticeIds.map((id, index) => ({
      id,
      instanceId,
      actorId: actors[1],
      message: `notification-${index}`,
      target: { page: 'edit' as const, id: own.id },
      createdAt: new Date(Date.now() + index * 1000).toISOString(),
    })),
  );
  const inbox = (await mutate('author', { operation: 'notifications' })) as {
    notifications: { id: string; target: { page: string; id: string }; read: boolean }[];
  };
  assert.equal(inbox.notifications.length, 5);
  assert.deepEqual(inbox.notifications[0].target, { page: 'edit', id: own.id });
  await mutate('reviewer', { operation: 'read-notifications', ids: [noticeIds[6]] });
  assert.equal(
    (
      await db
        .select()
        .from(schema.questionNotifications)
        .where(eq(schema.questionNotifications.id, noticeIds[6]))
    )[0].read,
    false,
  );
  await mutate('author', {
    operation: 'read-notifications',
    ids: inbox.notifications.map((row) => row.id),
  });
  const storedNotices = await db
    .select()
    .from(schema.questionNotifications)
    .where(eq(schema.questionNotifications.actorId, actors[1]));
  assert.equal(
    storedNotices.filter((row) => noticeIds.includes(row.id) && row.read).length,
    5,
  );
  assert.equal(storedNotices.find((row) => row.id === noticeIds[0])?.read, false);
  await assert.rejects(mutate('author', { operation: 'read-notifications' }));

  // Management actions are atomic, replayable and preserve deletion/return availability.
  const managedIds: string[] = [];
  for (const text of ['一括検証A', '一括検証B']) {
    const created = (await mutate('admin', {
      operation: 'save',
      input: { ...question, text },
    })) as { id: string };
    managedIds.push(created.id);
  }
  const managed = () =>
    db
      .select()
      .from(schema.questionSubmissions)
      .where(inArray(schema.questionSubmissions.id, managedIds));
  let batchRows = await managed();
  const batch = {
    operation: 'bulk',
    action: 'stop',
    reason: '一括検証',
    requestId: crypto.randomUUID(),
    changes: batchRows.map((r) => ({ id: r.id, revision: r.revision })),
  };
  await assert.rejects(
    mutate('admin', {
      ...batch,
      changes: [batch.changes[0], { ...batch.changes[1], revision: -1 }],
    }),
    /EDIT_CONFLICT/,
  );
  assert.deepEqual(
    (await managed()).map((r) => r.stopped),
    [false, false],
  );
  await mutate('admin', batch);
  await mutate('admin', batch);
  assert.deepEqual(
    (await managed()).map((r) => r.revision),
    batchRows.map((r) => r.revision + 1),
  );
  batchRows = await managed();
  await mutate('admin', {
    ...batch,
    action: 'delete',
    requestId: crypto.randomUUID(),
    changes: batchRows.map((r) => ({ id: r.id, revision: r.revision })),
  });
  batchRows = await managed();
  assert.ok(batchRows.every((r) => r.deletedAt));
  await assert.rejects(
    mutate('admin', {
      operation: 'resume',
      id: batchRows[0].id,
      revision: batchRows[0].revision,
      reason: '禁止',
    }),
    /QUESTION_DELETED/,
  );
  const exported = (await mutate('admin', {
    operation: 'export-managed',
    ids: managedIds,
    all: false,
  })) as { questions: import('../src/shared/question-transfer.ts').TransferQuestion[] };
  assert.equal(exported.questions.length, 2);
  assert.ok(exported.questions.every((r) => r.stopped));
  const whole = (await mutate('admin', {
    operation: 'export-managed',
    all: true,
  })) as typeof exported;
  assert.ok(whole.questions.every((r) => !r.input.text.startsWith('一括検証')));
  const transfer = {
    operation: 'import-transfer',
    requestId: crypto.randomUUID(),
    source: JSON.stringify({ version: 2, questions: exported.questions }),
    mapping: { 地理: { id: categoryId } },
  };
  await mutate('admin', transfer);
  await mutate('admin', transfer);
  const imported = (await overview('admin')).submissions.filter((r) =>
    r.input.text.startsWith('一括検証'),
  );
  assert.equal(imported.length, 2);
  assert.ok(
    imported.every(
      (r) =>
        r.status === 'draft' && r.stopped && r.provenance && !managedIds.includes(r.id),
    ),
  );
  await mutate('admin', {
    ...batch,
    action: 'restore',
    requestId: crypto.randomUUID(),
    changes: batchRows.map((r) => ({ id: r.id, revision: r.revision })),
  });
  assert.ok(
    (await managed()).every((r) => !r.deletedAt && r.stopped && r.status === 'draft'),
  );
  const currentManaged = async () => {
    const row = (await managed()).find((r) => r.id === managedIds[0]);
    assert.ok(row);
    return row;
  };
  const transition = async (operation: string) => {
    const r = await currentManaged();
    await mutate('admin', {
      operation,
      id: r.id,
      revision: r.revision,
      reason: '停止状態の検証',
    });
  };
  const fixedDraft = await currentManaged();
  await mutate('admin', {
    operation: 'bulk',
    action: 'difficulty',
    requestId: crypto.randomUUID(),
    reason: '未公開で固定',
    changes: [
      { id: fixedDraft.id, revision: fixedDraft.revision, difficulty: 2, fixed: true },
    ],
  });
  const fixedSettings = async () =>
    (
      await db
        .select()
        .from(schema.questionDifficulty)
        .where(
          and(
            eq(schema.questionDifficulty.instanceId, instanceId),
            eq(schema.questionDifficulty.seriesId, fixedDraft.seriesId),
          ),
        )
    )[0];
  assert.equal((await fixedSettings()).fixed, true);
  assert.equal((await fixedSettings()).current, 2);
  await transition('resume');
  await transition('submit');
  if ((await currentManaged()).status === 'pending') await transition('approve');
  assert.equal((await fixedSettings()).fixed, true);
  assert.equal((await fixedSettings()).current, 2);
  const available = async () => {
    const r = await currentManaged();
    assert.ok(r.publishedId);
    return (
      await db
        .select()
        .from(schema.questionAvailability)
        .where(
          and(
            eq(schema.questionAvailability.owner, owner),
            eq(schema.questionAvailability.questionId, r.publishedId),
          ),
        )
    )[0];
  };
  assert.equal((await available()).retiredAt, null);
  await transition('return');
  assert.equal((await currentManaged()).reviewHold, true);
  assert.ok((await available()).retiredAt);
  await transition('resume');
  assert.ok((await available()).retiredAt);
  await transition('delete');
  await transition('restore');
  assert.equal((await currentManaged()).status, 'returned');
  assert.ok((await available()).retiredAt);
  await transition('submit');
  if ((await currentManaged()).status === 'pending') await transition('approve');
  assert.equal((await currentManaged()).reviewHold, false);
  assert.equal((await available()).retiredAt, null);
  const malformedTransfer = {
    ...transfer,
    requestId: crypto.randomUUID(),
    source: JSON.stringify({
      version: 2,
      questions: [
        exported.questions[0],
        { ...exported.questions[1], category: '未対応カテゴリ' },
      ],
    }),
    mapping: { 地理: { name: '取消される新カテゴリ' } },
  };
  await assert.rejects(mutate('admin', malformedTransfer), /INVALID_CATEGORY/);
  assert.equal(
    (
      await db
        .select()
        .from(schema.questionCategories)
        .where(eq(schema.questionCategories.name, '取消される新カテゴリ'))
    ).length,
    0,
  );
  console.log(
    'PASS: published return hold, resume protection, restore hold, resubmission and import category rollback',
  );
  console.log(
    'PASS: atomic question bulk rollback/replay, soft deletion, exact restore, deleted selected export and portable import replay',
  );
  const reviewRollback = new Error('private import test rollback');
  await assert.rejects(
    db.transaction(async (tx) => {
      const privateId = crypto.randomUUID();
      await tx.insert(schema.instances).values({
        id: privateId,
        organizationId,
        name: '非公開取込検証',
        owner: `urn:uuid:${privateId}`,
        state: 'preparing',
      });
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      const privateMutation = (subject: string, body: Record<string, unknown>) =>
        questionMutation(tx, subject, privateId, body);
      await privateMutation('admin', { operation: 'category', name: '検証カテゴリ' });
      const [category] = await tx
        .select()
        .from(schema.questionCategories)
        .where(eq(schema.questionCategories.instanceId, privateId));
      const portable = {
        operation: 'import-transfer',
        requestId: crypto.randomUUID(),
        source: JSON.stringify({
          version: 2,
          questions: [
            {
              input: question,
              category: '検証カテゴリ',
              stopped: false,
              provenance: { author: '検証', instance: '元' },
            },
          ],
        }),
        mapping: { 検証カテゴリ: { id: category.id } },
      };
      for (const body of [{ operation: 'save', input: question }, portable])
        await assert.rejects(privateMutation('outsider', body), /INSTANCE_PREPARING/);
      assert.equal(
        (
          await tx
            .select()
            .from(schema.questionSubmissions)
            .where(eq(schema.questionSubmissions.instanceId, privateId))
        ).length,
        0,
      );
      await privateMutation('admin', portable);
      await tx
        .insert(schema.instanceGrants)
        .values({ instanceId: privateId, actorId: actors[2], permission: 'questions' });
      await privateMutation('reviewer', { ...portable, requestId: crypto.randomUUID() });
      assert.equal(
        (
          await tx
            .select()
            .from(schema.questionSubmissions)
            .where(eq(schema.questionSubmissions.instanceId, privateId))
        ).length,
        2,
      );
      throw reviewRollback;
    }),
    (error) => error === reviewRollback,
  );
  console.log(
    'PASS: private import permission boundary and unpublished fixed difficulty survives publication',
  );
  await verifyProfiles(db, {
    address,
    organizationId,
    instanceId,
    owner,
    actorId: actors[0],
  });
  console.log(
    '作問DB検証成功：実ロール認可・インスタンス分離・提出/差戻し/取下げ/承認・自己承認禁止・旧版保持・停止維持・審査なし切替・JSON再送/全件取消・審査者非公開',
  );
  await verifyModeration(db, { organizationId, instanceId, otherId, actors });
  await verifyInstanceOperations(db, instanceId, otherId);
  await verifyWorkflows(db, { organizationId, instanceId, otherId, actors });
  await verifyWithdrawal(db, organizationId, instanceId, actors);
  await verifyResultPrivacyRaces(db);
  await verifyRetention(db, organizationId, instanceId, actors);
  await verifyErasureBatches(db);
  await verifyInstanceDeletion(db, instanceId, otherId);
  if (process.env.OPERATIONS_SERVICE_QA === '1') {
    const { verifyErasureService } = await import('./check-erasure-service.ts');
    await verifyErasureService(db, address, directory, organizationId);
  }
} finally {
  await client?.end({ timeout: 5 });
  await cluster.end({ timeout: 5 });
  run('pg_ctl', ['-D', resolve(directory, 'data'), '-m', 'fast', '-w', 'stop']);
}
