import { applyD1Migrations, env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import {
  defaultQuestionSettings,
  emptyQuestion,
  type QuestionInput,
} from '../src/shared/questions';
import { loadMatchDefinition } from '../src/worker/catalog/database';
import { changeD1, connectD1 } from '../src/worker/db/d1';
import {
  databaseRevision,
  instances,
  questionAuthors,
  questionAvailability,
  questionCategories,
  questionDifficulty,
  questionNotifications,
  questionReports,
  questionReviewCases,
  questionSettings,
  questionSubmissionEvents,
  questionSubmissions,
  questionVersions,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import {
  addInstance,
  organizationIdentity,
  setInstanceGrants,
  setupOrganization,
} from '../src/worker/organization/database';
import { saveProfile } from '../src/worker/organization/profile';
import { questionOverview } from '../src/worker/questions/read';
import { questionMutation } from '../src/worker/questions/write';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '作問検証',
    instanceName: '初期対象',
  });
  await saveProfile(db, 'admin', { displayName: '管理者', revision: 0 }, 'local');
});
async function target(mode: 'open' | 'review' | 'qualified' = 'open') {
  const id = crypto.randomUUID();
  await addInstance(db, 'admin', { id, name: '対象インスタンス' });
  await changeD1(db, async (writes) => {
    writes.push(
      db.update(instances).set({ state: 'published' }).where(eq(instances.id, id)),
      db.insert(questionSettings).values({
        instanceId: id,
        config: { ...defaultQuestionSettings, mode, showAuthor: true },
      }),
    );
  });
  const [instance] = await db.select().from(instances).where(eq(instances.id, id));
  const subject = crypto.randomUUID();
  const account = (await organizationIdentity(db, subject)).account;
  await saveProfile(
    db,
    subject,
    { displayName: `投稿者${subject.slice(0, 8)}`, revision: 0 },
    'local',
  );
  const category = await questionMutation(db, 'admin', id, {
    operation: 'category',
    name: '通常カテゴリ',
  });
  const input: QuestionInput = {
    ...emptyQuestion(),
    text: 'あいさつ',
    displayAnswer: 'あ',
    readings: ['あ'],
    explanation: '説明',
    evidence: '根拠',
    categoryId: String(category.id),
    tags: ['ＡＢＣ'],
    difficulty: 0,
  };
  const mutate = (body: Record<string, unknown>, as: string = subject) =>
    questionMutation(db, as, id, body);
  const row = async (questionId: string) =>
    (
      await db
        .select()
        .from(questionSubmissions)
        .where(eq(questionSubmissions.id, questionId))
    )[0];
  const environment = {
    GAME_D1: runtime.GAME_D1,
    GAME_OWNER: instance.owner,
    GAME_CONFIG_PROFILE: 'local',
  } as Env;
  return {
    id,
    instance,
    subject,
    account,
    categoryId: String(category.id),
    input,
    mutate,
    row,
    environment,
  };
}
async function approved(context: Awaited<ReturnType<typeof target>>) {
  const saved = await context.mutate({ operation: 'save', input: context.input });
  const id = String(saved.id);
  await context.mutate({ operation: 'submit', id, revision: 1 });
  return context.row(id);
}
const list = (scope = 'mine', query = '') => ({
  scope,
  query,
  page: 1,
  pageSize: 100,
  category: '',
  status: '',
});

it('下書き保存・提出・出題版と通知をD1で保存し、他人の問題を取得できない', async () => {
  const context = await target();
  const row = await approved(context);
  expect(row.status).toBe('approved');
  const definition = await loadMatchDefinition(context.environment);
  expect(definition.questions[0].text).toBe(context.input.text);
  expect(definition.questions[0].answer).toBe('あ');
  const mine = await questionOverview(db, context.subject, context.id, list());
  expect(mine.submissions).toHaveLength(1);
  expect(
    (await questionOverview(db, 'stranger', context.id, list())).submissions,
  ).toHaveLength(0);
  expect(
    (
      await questionOverview(db, 'stranger', context.id, undefined, {
        page: 'edit',
        id: row.id,
      })
    ).submissions,
  ).toHaveLength(0);
  await expect(
    questionOverview(db, context.subject, context.id, list('all')),
  ).rejects.toThrow('REVIEW_FORBIDDEN');
  await expect(
    context.mutate({ operation: 'save', id: row.id, revision: 1, input: context.input }),
  ).rejects.toThrow('EDIT_CONFLICT');
});

it('審査担当者でも自己承認できず、差戻し・再提出・承認を新しい版にする', async () => {
  const context = await target('review');
  await setInstanceGrants(db, 'admin', {
    id: context.id,
    actorId: context.account.actorId,
    expected: '',
    permissions: ['questions'],
  });
  const saved = await context.mutate({ operation: 'save', input: context.input });
  const id = String(saved.id);
  await context.mutate({ operation: 'submit', id, revision: 1 });
  await expect(
    context.mutate({ operation: 'approve', id, revision: 2, reason: '' }),
  ).rejects.toThrow('REVIEW_FORBIDDEN');
  await context.mutate(
    { operation: 'return', id, revision: 2, reason: '修正してください' },
    'admin',
  );
  await context.mutate({
    operation: 'save',
    id,
    revision: 3,
    input: { ...context.input, text: '修正本文' },
  });
  await context.mutate({ operation: 'submit', id, revision: 4 });
  await context.mutate({ operation: 'approve', id, revision: 5, reason: '' }, 'admin');
  expect((await context.row(id)).revision).toBe(6);
  expect((await loadMatchDefinition(context.environment)).questions[0].text).toBe(
    '修正本文',
  );
  const notifications = await context.mutate({ operation: 'notifications' });
  expect(notifications.notifications).toHaveLength(2);
});

it('本文改訂中の難易度変更は公開済み本文だけを複写し、旧版の内容を変えない', async () => {
  const context = await target();
  const published = await approved(context);
  await context.mutate({
    operation: 'save',
    id: published.id,
    revision: 2,
    input: { ...context.input, text: 'まだ公開しない本文' },
  });
  await context.mutate(
    {
      operation: 'difficulty',
      changes: [{ id: published.id, revision: 3, difficulty: 2, fixed: true }],
      reason: '難易度を固定',
    },
    'admin',
  );
  const current = await context.row(published.id);
  expect(current.input.text).toBe('まだ公開しない本文');
  const [version] = await db
    .select()
    .from(questionVersions)
    .where(
      and(
        eq(questionVersions.owner, context.instance.owner),
        eq(questionVersions.questionId, String(current.publishedId)),
      ),
    );
  expect(version.payload.text).toBe(context.input.text);
  expect(version.payload.difficulty).toBe(2);
  const [old] = await db
    .select()
    .from(questionVersions)
    .where(
      and(
        eq(questionVersions.owner, context.instance.owner),
        eq(questionVersions.questionId, String(published.publishedId)),
      ),
    );
  expect(old.payload.text).toBe(context.input.text);
  expect(old.payload.difficulty).toBe(0);
  const [availability] = await db
    .select()
    .from(questionAvailability)
    .where(
      and(
        eq(questionAvailability.owner, context.instance.owner),
        eq(questionAvailability.questionId, String(published.publishedId)),
      ),
    );
  expect(availability.retiredAt).not.toBeNull();
});

it('500問JSON取込と再送、500問分類の末尾競合で一部だけ保存しない', async () => {
  const context = await target();
  const input = {
    operation: 'import',
    requestId: crypto.randomUUID(),
    questions: Array.from({ length: 500 }, (_, index) => ({
      ...context.input,
      text: `取込${index}`,
    })),
  };
  const first = await context.mutate(input),
    second = await context.mutate(input);
  expect(second.ids).toEqual(first.ids);
  expect(first.ids).toHaveLength(500);
  const ids = first.ids ?? [];
  const changes = ids.map((id) => ({ id, revision: 1, categoryId: context.categoryId }));
  const [before] = await db.select().from(databaseRevision);
  await expect(
    context.mutate(
      {
        operation: 'classify',
        changes: changes.map((change, index) =>
          index === 499 ? { ...change, revision: 0 } : change,
        ),
      },
      'admin',
    ),
  ).rejects.toThrow('EDIT_CONFLICT');
  expect((await db.select().from(databaseRevision))[0].revision).toBe(before.revision);
  expect((await context.row(ids[0])).revision).toBe(1);
  await context.mutate({ operation: 'classify', changes }, 'admin');
  expect((await context.row(ids[499])).revision).toBe(2);
  const events = await db
    .select()
    .from(questionSubmissionEvents)
    .where(eq(questionSubmissionEvents.instanceId, context.id));
  expect(events).toHaveLength(1000);
});

it('カテゴリ停止は公開版と編集中の分類を別々に移し、本文を先行公開しない', async () => {
  const context = await target();
  const row = await approved(context);
  const category = await context.mutate(
    { operation: 'category', name: '移動先' },
    'admin',
  );
  await context.mutate({
    operation: 'save',
    id: row.id,
    revision: 2,
    input: { ...context.input, text: '未承認改訂' },
  });
  await context.mutate(
    {
      operation: 'category',
      id: context.categoryId,
      revision: 1,
      name: '通常カテゴリ',
      active: false,
      destination: category.id,
    },
    'admin',
  );
  const current = await context.row(row.id);
  expect(current.input.categoryId).toBe(category.id);
  expect(current.input.text).toBe('未承認改訂');
  expect((await loadMatchDefinition(context.environment)).questions[0].text).toBe(
    context.input.text,
  );
  expect((await loadMatchDefinition(context.environment)).questions[0].categoryId).toBe(
    category.id,
  );
});

it('投稿方式変更は提出済み問題の承認と出題設定をまとめて反映する', async () => {
  const context = await target('review');
  const saved = await context.mutate({ operation: 'save', input: context.input });
  await context.mutate({ operation: 'submit', id: saved.id, revision: 1 });
  await context.mutate(
    {
      operation: 'settings',
      revision: 1,
      config: { ...defaultQuestionSettings, mode: 'open', showAuthor: true },
    },
    'admin',
  );
  expect((await context.row(String(saved.id))).status).toBe('approved');
  expect((await loadMatchDefinition(context.environment)).selection?.revision).toBe(2);
  const [configuration] = await db
    .select()
    .from(questionSettings)
    .where(eq(questionSettings.instanceId, context.id));
  expect(configuration.config.mode).toBe('open');
  await expect(
    context.mutate(
      {
        operation: 'settings',
        revision: 2,
        config: {
          ...defaultQuestionSettings,
          difficultyWeights: [
            [1, 1, 0],
            [1, 1, 0],
            [1, 1, 1],
          ],
        },
      },
      'admin',
    ),
  ).rejects.toThrow('INVALID_SETTINGS');
});

it('資格の申請・承認・取消・再申請待機を検査し、審査中の提出を終了する', async () => {
  const context = await target('qualified');
  await context.mutate({ operation: 'author-request', reason: '' });
  await context.mutate(
    {
      operation: 'author-decision',
      actorId: context.account.actorId,
      decision: 'qualified',
      revision: 1,
      reason: '',
    },
    'admin',
  );
  const saved = await context.mutate({ operation: 'save', input: context.input });
  await context.mutate({ operation: 'submit', id: saved.id, revision: 1 });
  await context.mutate(
    {
      operation: 'author-decision',
      actorId: context.account.actorId,
      decision: 'revoked',
      revision: 2,
      reason: '資格取消',
    },
    'admin',
  );
  expect((await context.row(String(saved.id))).status).toBe('ended');
  await expect(
    context.mutate({ operation: 'submit', id: saved.id, revision: 3 }),
  ).rejects.toThrow('SUBMISSION_FORBIDDEN');
  await context.mutate({ operation: 'author-request', reason: '' });
  await context.mutate(
    {
      operation: 'author-decision',
      actorId: context.account.actorId,
      decision: 'rejected',
      revision: 4,
      reason: '再確認が必要',
    },
    'admin',
  );
  await expect(
    context.mutate({ operation: 'author-request', reason: '' }),
  ).rejects.toThrow('AUTHOR_REQUEST_UNAVAILABLE');
  expect(
    (
      await db
        .select()
        .from(questionAuthors)
        .where(eq(questionAuthors.instanceId, context.id))
    )[0].retryAt,
  ).not.toBeNull();
});

it('NFKC検索とタグの別名・統合を反映し、100件ページと全並び順をD1で取得する', async () => {
  const context = await target();
  const input = {
    operation: 'import',
    requestId: crypto.randomUUID(),
    questions: Array.from({ length: 101 }, (_, index) => ({
      ...context.input,
      text: `ＡＢＣ　青${index}`,
      tags: index % 2 ? ['旧タグ'] : ['新タグ'],
    })),
  };
  await context.mutate(input);
  await context.mutate(
    { operation: 'merge-tags', from: '旧タグ', to: '新タグ' },
    'admin',
  );
  for (const sort of [
    'text',
    'answer',
    'status',
    'category',
    'author',
    'updatedAt',
    'difficulty',
    'reports',
  ]) {
    const overview = await questionOverview(db, 'admin', context.id, {
      ...list('all', 'abc 青'),
      sort,
      direction: 'asc',
    });
    expect(overview.submissions).toHaveLength(100);
    expect(overview.pagination?.total).toBe(101);
  }
  const aliases = await questionOverview(db, 'admin', context.id, list('all', '旧タグ'));
  expect(aliases.pagination?.total).toBe(101);
  expect(aliases.submissions.every((row) => row.input.tags.includes('新タグ'))).toBe(
    true,
  );
});

it('通報は同じ審議回に重複できず、解決後は新しい回で受け付ける', async () => {
  const context = await target();
  const row = await approved(context);
  const fixed = (await loadMatchDefinition(context.environment)).questions[0];
  const question = {
    ...fixed,
    displayAnswer: fixed.displayAnswer ?? fixed.answer,
    readings: fixed.readings ?? [fixed.answer],
    explanation: fixed.explanation ?? '',
    correct: true,
    participants: [context.account.actorId],
  };
  const input = {
    operation: 'report',
    questionId: question.id,
    kind: 'defect',
    reason: '内容確認',
  };
  await questionMutation(db, context.subject, context.id, input, 'local', question);
  await expect(
    questionMutation(db, context.subject, context.id, input, 'local', question),
  ).rejects.toThrow('ALREADY_REPORTED');
  await context.mutate(
    {
      operation: 'resolve-report',
      questionId: question.id,
      kind: 'defect',
      round: 1,
      reason: '修正不要',
    },
    'admin',
  );
  await questionMutation(db, context.subject, context.id, input, 'local', question);
  expect(
    await db
      .select()
      .from(questionReports)
      .where(eq(questionReports.instanceId, context.id)),
  ).toHaveLength(2);
  expect(
    (
      await db
        .select()
        .from(questionReviewCases)
        .where(eq(questionReviewCases.instanceId, context.id))
    )
      .map((reviewCase) => reviewCase.round)
      .sort(),
  ).toEqual([1, 2]);
  expect((await context.row(row.id)).status).toBe('approved');
});

it('一括停止の再送は版を重複させず、解除後も削除中の問題は出題しない', async () => {
  const context = await target();
  const row = await approved(context);
  const input = {
    operation: 'bulk',
    requestId: crypto.randomUUID(),
    action: 'stop',
    reason: '停止',
    changes: [{ id: row.id, revision: 2 }],
  };
  await context.mutate(input, 'admin');
  await context.mutate(input, 'admin');
  expect((await context.row(row.id)).revision).toBe(3);
  await expect(loadMatchDefinition(context.environment)).rejects.toThrow(
    'NO_RANKED_QUESTIONS',
  );
  await context.mutate(
    { operation: 'delete', id: row.id, revision: 3, reason: '削除' },
    'admin',
  );
  await expect(
    context.mutate(
      { operation: 'resume', id: row.id, revision: 4, reason: '解除' },
      'admin',
    ),
  ).rejects.toThrow('QUESTION_DELETED');
  await context.mutate(
    { operation: 'restore', id: row.id, revision: 4, reason: '復元' },
    'admin',
  );
  await expect(loadMatchDefinition(context.environment)).rejects.toThrow(
    'NO_RANKED_QUESTIONS',
  );
  await context.mutate(
    { operation: 'resume', id: row.id, revision: 5, reason: '再開' },
    'admin',
  );
  expect((await loadMatchDefinition(context.environment)).questions).toHaveLength(1);
});

it('移行JSONのカテゴリ作成と投稿を一括保存し、元作問者情報を維持する', async () => {
  const context = await target();
  const input = {
    operation: 'import-transfer',
    requestId: crypto.randomUUID(),
    source: JSON.stringify({
      version: 2,
      questions: [
        {
          input: context.input,
          category: '元分類',
          stopped: true,
          provenance: { author: '元作問者', instance: '元インスタンス' },
        },
      ],
    }),
    mapping: { 元分類: { name: '移行先' } },
  };
  await context.mutate(input, 'admin');
  await context.mutate(input, 'admin');
  const rows = await db
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.instanceId, context.id));
  expect(rows).toHaveLength(1);
  expect(rows[0].provenance?.author).toBe('元作問者');
  expect(rows[0].stopped).toBe(true);
  expect(
    await db
      .select()
      .from(questionCategories)
      .where(eq(questionCategories.instanceId, context.id)),
  ).toHaveLength(2);
});

it('本文の改訂は難易度集計世代を切り替え、カテゴリ等の変更では維持する', async () => {
  const context = await target();
  const row = await approved(context);
  const [before] = await db
    .select()
    .from(questionDifficulty)
    .where(eq(questionDifficulty.instanceId, context.id));
  await context.mutate({
    operation: 'save',
    id: row.id,
    revision: 2,
    input: { ...context.input, explanation: '解説のみ変更' },
  });
  await context.mutate({ operation: 'submit', id: row.id, revision: 3 });
  const [metadata] = await db
    .select()
    .from(questionDifficulty)
    .where(eq(questionDifficulty.instanceId, context.id));
  expect(metadata.generation).toBe(before.generation);
  await context.mutate({
    operation: 'save',
    id: row.id,
    revision: 4,
    input: { ...context.input, text: '本文を改訂' },
  });
  await context.mutate({ operation: 'submit', id: row.id, revision: 5 });
  const [updated] = await db
    .select()
    .from(questionDifficulty)
    .where(eq(questionDifficulty.instanceId, context.id));
  expect(updated.generation).not.toBe(before.generation);
  expect(updated.stats).toEqual([]);
  expect(updated.cursor).toBeNull();
  expect(
    await db
      .select()
      .from(questionNotifications)
      .where(eq(questionNotifications.instanceId, context.id)),
  ).toHaveLength(0);
});
