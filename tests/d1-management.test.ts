import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { expireRecords } from '../src/erasure/retention';
import { listCatalog, manageCatalog } from '../src/worker/catalog/manage';
import { changeD1, connectD1, rowsD1 } from '../src/worker/db/d1';
import {
  instances,
  organizationEvents,
  organizations,
  probeRuns,
  questionAvailability,
  questionReports,
  questionReviewCases,
  questionVersions,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import {
  addInstance,
  organizationIdentity,
  renameOrganization,
  setupOrganization,
} from '../src/worker/organization/database';
import { probeDatabase } from '../src/worker/probes/database';
import { verifiedReportedQuestion } from '../src/worker/questions/reports';
import { commitD1Result } from '../src/worker/results/database';
import { readInvestigation } from '../src/worker/results/investigation';
import { participantContext } from '../src/worker/rooms/database';
import { report } from '../src/worker/rooms/reports';
import { questions } from './fixtures/questions';
import { resultFixture } from './fixtures/result';

const runtime = env as unknown as {
    GAME_D1: D1Database;
    D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  },
  db = connectD1(runtime.GAME_D1);
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '管理検証',
    instanceName: '初期対象',
  });
});
async function target() {
  const id = crypto.randomUUID();
  await addInstance(db, 'admin', { id, name: '管理対象' });
  const [instance] = await db.select().from(instances).where(eq(instances.id, id));
  return instance;
}
it('組織名だけを管理者が変更し、競合・再送を検査して本人識別とインスタンスを保持する', async () => {
  const before = await organizationIdentity(db, 'admin');
  const savedInstances = await db.select().from(instances);
  const input = { name: '変更後の組織', expectedName: before.organization.name };
  await expect(renameOrganization(db, 'member', input)).rejects.toThrow('ADMIN_REQUIRED');
  await expect(
    renameOrganization(db, 'admin', { ...input, expectedName: '古い名前' }),
  ).rejects.toThrow('EDIT_CONFLICT');
  await expect(renameOrganization(db, 'admin', { ...input, name: ' ' })).rejects.toThrow(
    'INVALID_NAME',
  );
  await renameOrganization(db, 'admin', input);
  await renameOrganization(db, 'admin', input);
  const after = await organizationIdentity(db, 'admin');
  expect(after.organization).toMatchObject({
    id: before.organization.id,
    identityNamespace: before.organization.identityNamespace,
    name: input.name,
    federationRevision: before.organization.federationRevision + 1,
  });
  expect(after.account.actorId).toBe(before.account.actorId);
  expect(await db.select().from(instances)).toEqual(savedInstances);
  const changes = (await db.select().from(organizationEvents)).filter(
    (event) => event.action === 'rename',
  );
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    instanceId: null,
    details: { before: input.expectedName, after: input.name },
  });
  expect((await db.select().from(organizations))[0].name).toBe(input.name);
});
it('管理者だけが問題カタログを登録・改訂・停止でき、過去版と再送を保つ', async () => {
  const instance = await target(),
    question = { ...questions[0], id: crypto.randomUUID() };
  await expect(
    manageCatalog(
      db,
      instance.owner,
      { operation: 'register', question },
      'unprivileged',
    ),
  ).rejects.toThrow('ADMIN_REQUIRED');
  await manageCatalog(db, instance.owner, { operation: 'register', question }, 'admin');
  await manageCatalog(db, instance.owner, { operation: 'register', question }, 'admin');
  await manageCatalog(
    db,
    instance.owner,
    { operation: 'set', setId: 'set', questionIds: [question.id] },
    'admin',
  );
  const revised = { ...question, id: crypto.randomUUID(), text: '改訂本文' };
  await manageCatalog(
    db,
    instance.owner,
    { operation: 'revise', questionId: question.id, question: revised },
    'admin',
  );
  const catalog = await listCatalog(db, instance.owner, 'admin');
  expect(catalog.questions).toHaveLength(2);
  expect(
    catalog.questions.find((row) => row.questionId === question.id)?.retiredAt,
  ).not.toBeNull();
  expect(catalog.sets).toHaveLength(1);
  await expect(
    manageCatalog(
      db,
      instance.owner,
      { operation: 'set', setId: 'stopped', questionIds: [question.id] },
      'admin',
    ),
  ).rejects.toThrow('QUESTION_UNAVAILABLE');
});
it('D1プローブで実際のバッチの巻き戻しを確認し、検証行を残さない', async () => {
  expect(await probeDatabase(runtime.GAME_D1)).toEqual({
    committed: true,
    rolledBack: true,
    preparedStatements: true,
    database: 'd1',
  });
  expect(await db.select().from(probeRuns)).toEqual([]);
});
it('100問のセットでもD1のパラメーター上限を超えず、指定した順序を保存する', async () => {
  const instance = await target(),
    list = Array.from({ length: 100 }, () => ({
      ...questions[0],
      id: crypto.randomUUID(),
    }));
  await changeD1(db, async (writes) => {
    writes.push(
      rowsD1(
        questionVersions,
        list.map((question) => ({
          owner: instance.owner,
          questionId: question.id,
          version: 1,
          payload: question,
        })),
      ),
      rowsD1(
        questionAvailability,
        list.map((question) => ({ owner: instance.owner, questionId: question.id })),
      ),
    );
  });
  const result = await manageCatalog(
    db,
    instance.owner,
    {
      operation: 'set',
      setId: 'maximum-set',
      questionIds: list.map((question) => question.id),
    },
    'admin',
  );
  expect(result).toMatchObject({ setId: 'maximum-set', version: 1 });
  expect((await listCatalog(db, instance.owner, 'admin')).sets).toHaveLength(1);
});
it('参加済みの結果だけを通報でき、操作の再送で通報件数を増やさない', async () => {
  const instance = await target(),
    subject = crypto.randomUUID(),
    { account } = await organizationIdentity(db, subject),
    { record } = resultFixture();
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ state: 'published' })
        .where(eq(instances.id, instance.id)),
    );
  });
  record.owner = instance.owner;
  record.result.finishedAt = Date.now();
  record.players[0].id = account.actorId;
  record.definition.original = true;
  const question = questions[0];
  record.completedQuestions = [
    {
      ...question,
      id: 'original-test',
      displayAnswer: question.displayAnswer ?? question.answer,
      readings: question.readings ?? [question.answer],
      source: question.source ?? '',
      correct: true,
      participants: [],
    },
  ];
  await commitD1Result(runtime.GAME_D1, record);
  const environment = { GAME_D1: runtime.GAME_D1 } as Env,
    identity = await participantContext(
      environment,
      instance.id,
      'room',
      subject,
      undefined,
      true,
    );
  expect(
    (
      await verifiedReportedQuestion(
        environment,
        subject,
        instance.id,
        record.matchId,
        'original-test',
      )
    ).text,
  ).toBe(question.text);
  const input = {
    operationId: crypto.randomUUID(),
    matchId: record.matchId,
    action: 'question',
    questionId: 'original-test',
    kind: 'defect',
    reason: '誤り',
  };
  await report(environment, identity, input);
  await report(environment, identity, input);
  expect(
    (
      await db
        .select()
        .from(questionReviewCases)
        .where(eq(questionReviewCases.instanceId, instance.id))
    )[0].count,
  ).toBe(1);
  await expect(
    verifiedReportedQuestion(
      environment,
      'other',
      instance.id,
      record.matchId,
      'original-test',
    ),
  ).rejects.toThrow('QUESTION_NOT_FOUND');
  const other = await target();
  await expect(
    verifiedReportedQuestion(
      environment,
      subject,
      other.id,
      record.matchId,
      'original-test',
    ),
  ).rejects.toThrow();
  const investigation = await readInvestigation(
    db,
    instance.owner,
    account.actorId,
    record.matchId,
    {},
  );
  expect(investigation.reported?.matchId).toBe(record.matchId);
});
it('保存期限を過ぎた証跡だけを消し、通報の集計件数を残った記録に合わせる', async () => {
  const instance = await target(),
    { account } = await organizationIdentity(db, 'admin'),
    old = new Date(Date.now() - 366 * 86400000).toISOString(),
    recent = new Date().toISOString();
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(organizationEvents).values([
        {
          id: crypto.randomUUID(),
          actorId: account.actorId,
          instanceId: instance.id,
          action: 'grants',
          occurredAt: old,
          details: {},
        },
        {
          id: crypto.randomUUID(),
          actorId: account.actorId,
          instanceId: instance.id,
          action: 'grants',
          occurredAt: recent,
          details: {},
        },
      ]),
      db.insert(questionReviewCases).values({
        instanceId: instance.id,
        questionId: 'review',
        kind: 'defect',
        round: 1,
        count: 2,
      }),
      db.insert(questionReports).values([
        {
          id: crypto.randomUUID(),
          instanceId: instance.id,
          questionId: 'review',
          kind: 'defect',
          round: 1,
          actorId: 'old',
          reason: '古い通報',
          createdAt: old,
        },
        {
          id: crypto.randomUUID(),
          instanceId: instance.id,
          questionId: 'review',
          kind: 'defect',
          round: 1,
          actorId: 'current',
          reason: '現在の通報',
          createdAt: recent,
        },
      ]),
    );
  });
  expect(await expireRecords(db)).toBe(true);
  expect(await expireRecords(db)).toBe(false);
  expect(
    await db
      .select()
      .from(organizationEvents)
      .where(eq(organizationEvents.instanceId, instance.id)),
  ).toHaveLength(2);
  expect(
    (
      await db
        .select()
        .from(questionReviewCases)
        .where(eq(questionReviewCases.instanceId, instance.id))
    )[0].count,
  ).toBe(1);
  expect(
    await db
      .select()
      .from(questionReports)
      .where(eq(questionReports.instanceId, instance.id)),
  ).toHaveLength(1);
});
