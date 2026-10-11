import { applyD1Migrations, env } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { exportSPKI, generateKeyPair } from 'jose';
import { beforeAll, expect, it } from 'vitest';
import { emptyQuestion } from '../src/shared/questions';
import { contentHash } from '../src/worker/catalog/hash';
import { changeD1, connectD1 } from '../src/worker/db/d1';
import {
  federationDeletedInstances,
  federationPeers,
  federationQuestionImports,
  federationQuestionLinks,
  instances,
  matchResults,
  organizationAccounts,
  questionSubmissions,
  questionVersions,
  resultOutbox,
  resultPlayers,
  resultPrivacyChanges,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import {
  organizationIdentity,
  setupOrganization,
} from '../src/worker/organization/database';
import { commitD1Result, eraseResult } from '../src/worker/results/database';
import { privateResult } from '../src/worker/results/privacy';
import { readResults } from '../src/worker/results/read';
import { questions } from './fixtures/questions';
import { resultFixture } from './fixtures/result';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
let instance: typeof instances.$inferSelect;
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '隔離検証',
    instanceName: '検証先',
  });
  [instance] = await db.select().from(instances);
});

it('24問と作問者名を持つ結果を保存・再読取し、出題済み情報と匿名化の境界を保持する', async () => {
  const { record } = resultFixture();
  const { account } = await organizationIdentity(db, crypto.randomUUID());
  record.owner = instance.owner;
  record.players[0].id = account.actorId;
  record.result.winnerId = account.actorId;
  record.result.finishedAt = Date.now();
  record.completedQuestions = Array.from({ length: 24 }, () => ({
    ...questions[0],
    id: crypto.randomUUID(),
    displayAnswer: questions[0].answer,
    readings: [questions[0].answer],
    source: '',
    authorName: '検証作問者',
    correct: false,
    participants: [],
  }));
  record.definition.selection = {
    band: 0,
    boundaries: [800, 1200],
    weights: [1, 1, 1],
    categories: {},
    revision: 1,
    authorNames: Object.fromEntries(
      record.completedQuestions.map((question) => [
        question.id,
        question.authorName ?? '',
      ]),
    ),
  };
  await commitD1Result(runtime.GAME_D1, record);
  const projected = await privateResult(db, record);
  expect(projected).toEqual(record);
  await commitD1Result(runtime.GAME_D1, record);
  expect(
    (
      await db
        .select()
        .from(matchResults)
        .where(eq(matchResults.resultId, record.result.id))
    )[0].payload,
  ).toEqual(record);
  await withdraw(account.actorId);
  expect(await eraseResult(db, record.result.id)).toBe(true);
  const [anonymous] = await db
    .select()
    .from(matchResults)
    .where(eq(matchResults.resultId, record.result.id));
  expect(anonymous.payload.players[0].name).toBe('退会ユーザー');
  expect(anonymous.payload.completedQuestions).toHaveLength(24);
  const invalid = structuredClone(anonymous.payload);
  invalid.players[0].correct++;
  await expect(
    db.insert(resultPrivacyChanges).values({
      resultId: record.result.id,
      previousHash: anonymous.payloadHash,
      payload: invalid,
      payloadHash: await contentHash(invalid),
    }),
  ).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringContaining('INVALID_PRIVACY_PROJECTION'),
    }),
  });
});

async function authoredResult(provenance = false) {
  const { account } = await organizationIdentity(db, crypto.randomUUID());
  const { record } = resultFixture();
  record.owner = instance.owner;
  record.result.finishedAt = Date.now();
  record.players[0].id = account.actorId;
  record.result.winnerId = account.actorId;
  const id = crypto.randomUUID();
  const published = { ...questions[0], id, seriesId: id, authorName: '作問者名' };
  record.completedQuestions = [
    {
      ...published,
      displayAnswer: published.displayAnswer ?? published.answer,
      readings: published.readings ?? [published.answer],
      source: published.source ?? '',
      correct: true,
      participants: [],
    },
  ];
  record.definition.selection = {
    authorNames: { [id]: '作問者名' },
    band: 0,
    boundaries: [1200, 1600],
    weights: [1, 0, 0],
    categories: {},
    revision: 1,
  };
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(questionVersions).values({
        owner: instance.owner,
        questionId: id,
        version: 1,
        payload: published,
      }),
      db.insert(questionSubmissions).values({
        id,
        instanceId: instance.id,
        seriesId: id,
        authorId: account.actorId,
        authorName: '作問者名',
        input: emptyQuestion(),
        publishedId: id,
        provenance: provenance ? { author: '転入元作問者', instance: '転入元' } : null,
      }),
    );
  });
  return { record, account, id };
}

async function withdraw(actorId: string) {
  // This is an isolated D1 fixture; no Auth account or user's working DB is touched.
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(organizationAccounts)
        .set({
          withdrawnAt: new Date().toISOString(),
          displayName: null,
          administrator: false,
        })
        .where(eq(organizationAccounts.actorId, actorId)),
    );
  });
}

it('共有作問者を匿名化し、完全削除された共有元の振り返りを閉じる投影だけを許す', async () => {
  const { record, account, id } = await authoredResult(true);
  const origin = 'https://shared.quiz-relay.workers.dev',
    sourceId = crypto.randomUUID(),
    importId = crypto.randomUUID();
  const question = record.completedQuestions?.[0];
  if (!question) throw new Error('MISSING_QUESTION');
  question.sharedSource = {
    peerOrigin: origin,
    instanceId: sourceId,
    questionId: id,
    seriesId: id,
    authorId: account.actorId,
  };
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(federationPeers).values({
        origin,
        name: '共有元',
        kid: 'shared',
        publicKey: await exportSPKI(
          (await generateKeyPair('EdDSA', { extractable: true })).publicKey,
        ),
      }),
      db.insert(federationQuestionImports).values({
        id: importId,
        instanceId: instance.id,
        peerOrigin: origin,
        sourceInstanceId: sourceId,
        config: {
          categories: [],
          targetCategoryId: crypto.randomUUID(),
          difficulty: {},
          fallback: 0,
        },
      }),
      db.insert(federationQuestionLinks).values({
        instanceId: instance.id,
        peerOrigin: origin,
        sourceInstanceId: sourceId,
        sourceSeriesId: id,
        importId,
        submissionId: id,
        sourceQuestionId: id,
        sourceHash: 'a'.repeat(64),
        sourceCategory: { id: crypto.randomUUID(), name: '共有' },
        sourceDifficulty: 0,
        sourceAuthorId: account.actorId,
        seenSnapshot: 'a'.repeat(64),
      }),
    );
  });
  await commitD1Result(runtime.GAME_D1, record);
  await withdraw(account.actorId);
  expect((await privateResult(db, record)).completedQuestions?.[0].authorName).toBe(
    '退会ユーザー',
  );
  expect(await eraseResult(db, record.result.id)).toBe(true);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .insert(federationDeletedInstances)
        .values({ peerOrigin: origin, instanceId: sourceId, deletedAt: Date.now() }),
    );
  });
  const closed = await privateResult(db, record);
  expect(closed.completedQuestions?.[0].text).toContain('削除された共有元');
  expect(closed.completedQuestions?.[0].readings).toEqual([]);
  expect(closed.completedQuestions?.[0].authorName).toBe('退会ユーザー');
  expect(await eraseResult(db, record.result.id)).toBe(true);
});

it('退会した参加者と作問者の名前を隠し、3つの原本を一緒に匿名化する', async () => {
  const { record, account, id } = await authoredResult();
  await commitD1Result(runtime.GAME_D1, record);
  await withdraw(account.actorId);
  const projected = await privateResult(db, record);
  const overview = await readResults(db, instance.owner, account.actorId);
  expect(overview.ranking.find((row) => row.actorId === account.actorId)?.name).toBe(
    '退会ユーザー',
  );
  expect(
    overview.history[0].players.find((row) => row.id === account.actorId)?.name,
  ).toBe('退会ユーザー');
  expect(overview.history[0].questions?.[0].authorName).toBe('退会ユーザー');
  expect(projected.players[0].name).toBe('退会ユーザー');
  expect(projected.completedQuestions?.[0].authorName).toBe('退会ユーザー');
  expect(projected.definition.selection?.authorNames?.[id]).toBe('退会ユーザー');
  expect(await eraseResult(db, record.result.id)).toBe(true);
  const [saved] = await db
    .select()
    .from(matchResults)
    .where(eq(matchResults.resultId, record.result.id));
  const [outbox] = await db
    .select()
    .from(resultOutbox)
    .where(eq(resultOutbox.resultId, record.result.id));
  const players = await db
    .select()
    .from(resultPlayers)
    .where(eq(resultPlayers.resultId, record.result.id));
  expect(saved.payload).toEqual(projected);
  expect(outbox.payload).toEqual(projected);
  expect(saved.payloadHash).toBe(await contentHash(projected));
  expect(outbox.payloadHash).toBe(saved.payloadHash);
  expect(players.find((row) => row.actorId === account.actorId)?.name).toBe(
    '退会ユーザー',
  );
  expect(await db.select().from(resultPrivacyChanges)).toEqual([]);
  expect(await eraseResult(db, record.result.id)).toBe(false);
  expect((await commitD1Result(runtime.GAME_D1, record)).rowsWritten).toBe(0);
  expect(
    (
      await db
        .select()
        .from(matchResults)
        .where(eq(matchResults.resultId, record.result.id))
    )[0].payload,
  ).toEqual(projected);
});

it('D1の順位は同点を同順位とし、除外後も本人のレートを保持する', async () => {
  const { record } = resultFixture();
  record.owner = 'https://ranking-only.test';
  record.result.finishedAt = Date.now();
  await commitD1Result(runtime.GAME_D1, record);
  const second = structuredClone(record);
  second.result.id = crypto.randomUUID();
  second.matchId = crypto.randomUUID();
  second.players[0].id = 'c';
  second.players[0].name = 'C';
  second.players[1].id = 'd';
  second.players[1].name = 'D';
  second.result.winnerId = 'c';
  await commitD1Result(runtime.GAME_D1, second);
  const overview = await readResults(db, record.owner, 'a');
  expect(overview.ranking.map((row) => [row.actorId, row.rank, row.rating])).toEqual([
    ['a', 1, 1020],
    ['c', 1, 1020],
    ['b', 3, 980],
    ['d', 3, 980],
  ]);
  expect((await readResults(db, record.owner, 'a', ['a'])).self).toEqual({
    rank: null,
    rating: 1020,
  });
  expect((await readResults(db, 'https://different.test', 'a')).history).toEqual([]);
});

it('同時刻の履歴もカーソルで重複・欠落なく読み、一覧に回答本文を含めない', async () => {
  const { record } = resultFixture();
  record.owner = 'https://history-only.test';
  record.result.finishedAt = Date.now();
  record.completedQuestions = [
    {
      ...questions[0],
      displayAnswer: questions[0].displayAnswer ?? questions[0].answer,
      readings: questions[0].readings ?? [questions[0].answer],
      source: questions[0].source ?? '',
      correct: true,
      participants: [],
    },
  ];
  const ids = [];
  for (let index = 0; index < 23; index++) {
    record.matchId = crypto.randomUUID();
    record.result.id = crypto.randomUUID();
    ids.push(record.result.id);
    await commitD1Result(runtime.GAME_D1, record);
  }
  const first = await readResults(db, record.owner, 'a', [], { section: 'history' });
  expect(first.history).toHaveLength(20);
  expect(first.history.every((entry) => entry.questions === undefined)).toBe(true);
  expect(first.nextCursor).toBeTruthy();
  if (!first.nextCursor) throw new Error('CURSOR_REQUIRED');
  const second = await readResults(db, record.owner, 'a', [], {
    section: 'history',
    cursor: first.nextCursor,
  });
  expect(second.history).toHaveLength(3);
  expect(second.nextCursor).toBe(null);
  expect(
    [...first.history, ...second.history].map((entry) => entry.resultId).sort(),
  ).toEqual(ids.sort());
  const detail = await readResults(db, record.owner, 'a', [], {
    section: 'history',
    resultId: ids[0],
  });
  expect(detail.history[0].questions?.[0].displayAnswer).toBe(
    record.completedQuestions[0].displayAnswer,
  );
  expect(
    (
      await readResults(db, record.owner, 'someone-else', [], {
        section: 'history',
        resultId: ids[0],
      })
    ).history,
  ).toEqual([]);
});

it('取込み時の出典名は、取込者の退会で消さない', async () => {
  const { record, account, id } = await authoredResult(true);
  await withdraw(account.actorId);
  const projected = await privateResult(db, record);
  expect(projected.players[0].name).toBe('退会ユーザー');
  expect(projected.completedQuestions?.[0].authorName).toBe('作問者名');
  expect(projected.definition.selection?.authorNames?.[id]).toBe('作問者名');
});

it('別組織の参加者や作問者の名前を、こちらの退会処理で変えない', async () => {
  const { record, account } = await authoredResult();
  await withdraw(account.actorId);
  record.owner = 'https://other-organization.test';
  expect(await privateResult(db, record)).toEqual(record);
});

it('30日でゲスト名と持込み問題、365日で通常の問題本文を除去する', async () => {
  const { record } = resultFixture();
  record.players[0].guest = true;
  record.completedQuestions = [
    {
      ...questions[0],
      displayAnswer: questions[0].displayAnswer ?? questions[0].answer,
      readings: questions[0].readings ?? [questions[0].answer],
      source: questions[0].source ?? '',
      correct: true,
      participants: [],
    },
  ];
  record.result.finishedAt = Date.now() - 31 * 86400000;
  record.definition.original = true;
  const personal = await privateResult(db, record);
  expect(personal.players[0].name).toBe('ゲスト');
  expect(personal.completedQuestions).toBeUndefined();
  delete record.definition.original;
  const regular = await privateResult(db, record);
  expect(regular.completedQuestions).toEqual(record.completedQuestions);
  record.result.finishedAt = Date.now() - 366 * 86400000;
  expect((await privateResult(db, record)).completedQuestions).toBeUndefined();
  await commitD1Result(runtime.GAME_D1, record);
  expect(
    (
      await db
        .select()
        .from(matchResults)
        .where(eq(matchResults.resultId, record.result.id))
    )[0].payload.completedQuestions,
  ).toBeUndefined();
});

it('匿名化を装った得点・回答・名前の改変をDBの許可証検査で拒否する', async () => {
  const { record } = await authoredResult();
  await commitD1Result(runtime.GAME_D1, record);
  const [stored] = await db
    .select()
    .from(matchResults)
    .where(eq(matchResults.resultId, record.result.id));
  for (const change of [
    (value: typeof record) => {
      value.players[0].correct += 1;
    },
    (value: typeof record) => {
      value.players[0].name = '偽名';
    },
    (value: typeof record) => {
      const question = value.completedQuestions?.[0];
      if (!question) throw new Error('QUESTION_FIXTURE_REQUIRED');
      question.displayAnswer = '改変';
    },
  ]) {
    const payload = structuredClone(record);
    change(payload);
    await expect(
      changeD1(db, async (writes) => {
        writes.push(
          db.insert(resultPrivacyChanges).values({
            resultId: record.result.id,
            previousHash: stored.payloadHash,
            payloadHash: await contentHash(payload),
            payload,
          }),
        );
      }),
    ).rejects.toThrow('INVALID_PRIVACY_PROJECTION');
  }
  await expect(
    runtime.GAME_D1.prepare(
      'update quiz_game_result_players set rating_delta = 0 where result_id = ?',
    )
      .bind(record.result.id)
      .run(),
  ).rejects.toThrow('IMMUTABLE_RESULT_PLAYER');
  expect(await db.select().from(resultPrivacyChanges)).toEqual([]);
});

it('匿名化途中で失敗しても原本・参加者名・許可証を残さない', async () => {
  const { record, account } = await authoredResult();
  await commitD1Result(runtime.GAME_D1, record);
  await withdraw(account.actorId);
  const [stored] = await db
    .select()
    .from(matchResults)
    .where(eq(matchResults.resultId, record.result.id));
  const payload = await privateResult(db, record),
    payloadHash = await contentHash(payload);
  await expect(
    changeD1(db, async (writes) => {
      writes.push(
        db.insert(resultPrivacyChanges).values({
          resultId: record.result.id,
          previousHash: stored.payloadHash,
          payloadHash,
          payload,
        }),
        db
          .update(matchResults)
          .set({ payload, payloadHash })
          .where(eq(matchResults.resultId, record.result.id)),
        sql`insert into no_such_table (id) values ('fail')`,
      );
    }),
  ).rejects.toThrow();
  expect(
    (
      await db
        .select()
        .from(matchResults)
        .where(eq(matchResults.resultId, record.result.id))
    )[0].payload,
  ).toEqual(record);
  expect(
    (
      await db
        .select()
        .from(resultOutbox)
        .where(eq(resultOutbox.resultId, record.result.id))
    )[0].payload,
  ).toEqual(record);
  expect(await db.select().from(resultPrivacyChanges)).toEqual([]);
});
