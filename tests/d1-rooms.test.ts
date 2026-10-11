import { applyD1Migrations, env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { emptyQuestion } from '../src/shared/questions';
import { loadMatchDefinition } from '../src/worker/catalog/database';
import { validateDefinition } from '../src/worker/catalog/definition';
import { changeD1, connectD1, rowsD1 } from '../src/worker/db/d1';
import {
  instances,
  organizationAccounts,
  personalQuestionSets,
  questionAvailability,
  questionSettings,
  questionSubmissions,
  questionVersions,
  roomDirectory,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import {
  addInstance,
  organizationIdentity,
  setupOrganization,
} from '../src/worker/organization/database';
import { currentProfileNames, saveProfile } from '../src/worker/organization/profile';
import { registerInstanceRoom } from '../src/worker/organization/rooms';
import { publishQuestionCatalog } from '../src/worker/questions/catalog';
import { QuestionPlan } from '../src/worker/questions/plan';
import {
  createGuest,
  ensureCasualCatalog,
  guestIdentity,
  mutatePersonalSet,
  participantContext,
  personalSets,
  publishRoom,
  roomDefinition,
  saveCasualSettings,
} from '../src/worker/rooms/database';
import { questions } from './fixtures/questions';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
const environment = { GAME_D1: runtime.GAME_D1, GAME_CONFIG_PROFILE: 'local' } as Env;
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '部屋検証',
    instanceName: '初期対象',
  });
});
async function target() {
  const id = crypto.randomUUID();
  await addInstance(db, 'admin', { id, name: '検証対象' });
  const [instance] = await db.select().from(instances).where(eq(instances.id, id));
  return instance;
}

it('通常投稿の公開版と作問者表示から部屋の固定原本を検証できる', async () => {
  const instance = await target();
  const identity = await organizationIdentity(db, 'admin');
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(questionSettings).values({
        instanceId: instance.id,
        config: {
          mode: 'open',
          authorWaitDays: 1,
          showAuthor: true,
          reportThreshold: 3,
          categoryReportThreshold: 3,
        },
      }),
    );
    const plan = new QuestionPlan(instance.id, instance.owner);
    await plan.load(db, { operation: 'qa-shared-seed' });
    for (const question of questions) {
      const row = plan.draft(
        identity.account.actorId,
        '検証作問者',
        {
          ...emptyQuestion(),
          text: question.text,
          displayAnswer: question.answer,
          readings: [question.answer],
          explanation: question.explanation || '解説',
          source: '独自作成',
          evidence: '根拠',
          difficulty: 0,
        },
        { status: 'approved' },
      );
      plan.save(row, { publishedId: await plan.publish(row) });
    }
    plan.flush(writes);
  });
  const definition = await roomDefinition(
    environment,
    { id: instance.id, owner: instance.owner, mode: 'room' },
    {
      source: 'normal',
      categories: [],
      difficulties: [0, 1, 2],
      capacity: 2,
      count: 1,
      mistakes: 3,
      winMode: 'questions',
      name: '部屋',
      public: true,
      presenter: false,
      guests: false,
    },
    [],
    crypto.randomUUID(),
  );
  expect((await validateDefinition(definition)).questions).toHaveLength(questions.length);
});

it('500問の持込セットは本人だけが更新でき、再送・並行編集・削除を確認する', async () => {
  const subject = crypto.randomUUID();
  const id = crypto.randomUUID();
  const selected = Array.from({ length: 500 }, (_, index) => ({
    text: `問題${index}`,
    displayAnswer: 'あ',
    readings: ['あ'],
    explanation: '',
  }));
  const input = {
    id,
    action: 'save',
    operationId: crypto.randomUUID(),
    revision: 0,
    name: '持込',
    questions: selected,
  };
  await mutatePersonalSet(environment, subject, input);
  await mutatePersonalSet(environment, subject, input);
  expect((await personalSets(environment, subject))[0].questions).toHaveLength(500);
  await expect(
    mutatePersonalSet(environment, 'other', {
      ...input,
      operationId: crypto.randomUUID(),
      revision: 1,
    }),
  ).rejects.toThrow('EDIT_CONFLICT');
  const responses = await Promise.allSettled([
    mutatePersonalSet(environment, subject, {
      ...input,
      operationId: crypto.randomUUID(),
      revision: 1,
      name: '編集A',
    }),
    mutatePersonalSet(environment, subject, {
      ...input,
      operationId: crypto.randomUUID(),
      revision: 1,
      name: '編集B',
    }),
  ]);
  expect(responses.filter((response) => response.status === 'fulfilled')).toHaveLength(1);
  await mutatePersonalSet(environment, subject, {
    id,
    action: 'delete',
    operationId: crypto.randomUUID(),
    revision: 2,
  });
  expect(
    await db.select().from(personalQuestionSets).where(eq(personalQuestionSets.id, id)),
  ).toHaveLength(0);
});

it('ゲストの名前設定は再送で期限を延長せず、禁止・停止・ログイン必須を判定する', async () => {
  const instance = await target();
  const token = '8'.repeat(64);
  const input = { operationId: crypto.randomUUID(), name: 'ゲスト' };
  await createGuest(environment, input, token);
  const before = await guestIdentity(environment, token);
  await createGuest(environment, input, token);
  expect((await guestIdentity(environment, token)).expiresAt).toBe(before.expiresAt);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({
          state: 'published',
          casualConfig: {
            enabled: true,
            players: 2,
            casualGuests: true,
            roomGuests: false,
          },
        })
        .where(eq(instances.id, instance.id)),
    );
  });
  const context = await participantContext(
    environment,
    instance.id,
    'casual',
    undefined,
    token,
  );
  expect(context.actor.guest).toBe(true);
  await expect(
    participantContext(environment, instance.id, 'room', undefined, token),
  ).rejects.toThrow('GUEST_NOT_ALLOWED');
  await expect(
    participantContext(environment, instance.id, 'room', undefined, token, false, true),
  ).rejects.toThrow('LOGIN_REQUIRED');
  await expect(guestIdentity(environment, 'invalid')).rejects.toThrow('GUEST_REQUIRED');
});

it('出題用1001問を分割して保存し、人数設定の新しい版だけを次の試合へ反映する', async () => {
  const instance = await target();
  const identity = await organizationIdentity(db, 'admin');
  const categoryId = crypto.randomUUID();
  const selected = Array.from({ length: 1001 }, (_, index) => ({
    ...questions[index % questions.length],
    id: crypto.randomUUID(),
    difficulty: 0,
    categoryId,
  }));
  const submitted = selected.map((question) => ({
    id: question.id,
    instanceId: instance.id,
    seriesId: question.id,
    authorId: identity.account.actorId,
    authorName: '初期表示',
    input: {
      text: question.text,
      displayAnswer: question.displayAnswer ?? question.answer,
      readings: question.readings ?? [question.answer],
      explanation: question.explanation ?? '',
      source: question.source,
      evidence: '根拠',
      tags: [],
      traps: [],
      categoryId,
      difficulty: 0,
    },
    publishedId: question.id,
    status: 'approved' as const,
  }));
  await changeD1(db, async (writes) => {
    writes.push(
      rowsD1(
        questionVersions,
        selected.map((question) => ({
          owner: instance.owner,
          questionId: question.id,
          version: 1,
          payload: question,
        })),
      ),
      rowsD1(
        questionAvailability,
        selected.map((question) => ({
          owner: instance.owner,
          questionId: question.id,
          retiredAt: null,
        })),
      ),
      rowsD1(questionSubmissions, submitted),
    );
  });
  await ensureCasualCatalog(environment, instance.id);
  const activeEnvironment = { ...environment, GAME_OWNER: instance.owner };
  const before = await loadMatchDefinition(activeEnvironment);
  expect(before.questions).toHaveLength(1001);
  const config = { enabled: true, players: 2, casualGuests: true, roomGuests: true };
  const input = {
    id: instance.id,
    operationId: crypto.randomUUID(),
    revision: instance.operationRevision,
    config,
    rankedPlayers: 3,
  };
  await saveCasualSettings(environment, 'admin', input);
  await saveCasualSettings(environment, 'admin', input);
  expect((await loadMatchDefinition(activeEnvironment)).playersPerMatch).toBe(3);
  expect(
    (
      await loadMatchDefinition({
        ...activeEnvironment,
        GAME_CONFIG_PROFILE: 'local-casual',
      })
    ).playersPerMatch,
  ).toBe(2);
  const historical = await loadMatchDefinition(activeEnvironment, before.competition);
  expect(historical.playersPerMatch).toBe(4);
  expect(historical.manifestHash).toBe(before.manifestHash);
  await expect(
    saveCasualSettings(environment, 'other', {
      ...input,
      operationId: crypto.randomUUID(),
    }),
  ).rejects.toThrow('ADMIN_REQUIRED');
});

it('プロフィールと新しい作問者表示を原子保存し、転載の原著者と過去版を維持する', async () => {
  const instance = await target();
  const subject = crypto.randomUUID();
  const identity = await organizationIdentity(db, subject);
  await saveProfile(db, subject, { displayName: '作問者A', revision: 0 }, 'local');
  const question = { ...questions[0], id: crypto.randomUUID(), difficulty: 0 };
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(questionSettings).values({
        instanceId: instance.id,
        config: {
          mode: 'open',
          authorWaitDays: 1,
          showAuthor: true,
          reportThreshold: 3,
          categoryReportThreshold: 3,
        },
      }),
      db.insert(questionVersions).values({
        owner: instance.owner,
        questionId: question.id,
        version: 1,
        payload: question,
      }),
      db
        .insert(questionAvailability)
        .values({ owner: instance.owner, questionId: question.id }),
      db.insert(questionSubmissions).values({
        id: question.id,
        seriesId: question.id,
        instanceId: instance.id,
        authorId: identity.account.actorId,
        authorName: '作問者A',
        publishedId: question.id,
        input: {
          text: question.text,
          displayAnswer: question.answer,
          readings: [question.answer],
          explanation: '',
          source: '',
          evidence: '根拠',
          tags: [],
          traps: [],
          categoryId: '',
          difficulty: 0,
        },
      }),
    );
  });
  await changeD1(db, async (writes) => {
    await publishQuestionCatalog(db, writes, instance.id, instance.owner, 'local');
  });
  const activeEnvironment = { ...environment, GAME_OWNER: instance.owner };
  const old = await loadMatchDefinition(activeEnvironment);
  await saveProfile(db, subject, { displayName: '作問者B', revision: 1 }, 'local');
  const next = await loadMatchDefinition(activeEnvironment);
  expect(next.selection?.authorNames?.[question.id]).toBe('作問者B');
  expect(
    (await loadMatchDefinition(activeEnvironment, old.competition)).selection
      ?.authorNames?.[question.id],
  ).toBe('作問者A');
  await expect(
    saveProfile(db, 'other', { displayName: '作問者B', revision: 0 }, 'local'),
  ).rejects.toThrow('DISPLAY_NAME_TAKEN');
  const names = await currentProfileNames(
    db,
    identity.organization.id,
    Array.from({ length: 500 }, () => identity.account.actorId),
  );
  expect(names.get(identity.account.actorId)).toBe('作問者B');
  const [submission] = await db
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.id, question.id));
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(questionSubmissions)
        .set({ provenance: { author: '原著者', instance: '元の組織' } })
        .where(eq(questionSubmissions.id, submission.id)),
    );
  });
  await saveProfile(db, subject, { displayName: '作問者C', revision: 2 }, 'local');
  expect(
    (await loadMatchDefinition(activeEnvironment)).selection?.authorNames?.[question.id],
  ).toBe('原著者');
});

it('部屋登録の範囲を守り、退会作問者の名前を出題固定時にも匿名化する', async () => {
  const instance = await target();
  const scope = { id: instance.id, owner: instance.owner, mode: 'room' as const };
  const id = crypto.randomUUID();
  await publishRoom(environment, id, instance.id, true, false);
  await publishRoom(environment, id, instance.id, false, true);
  const other = await target();
  await expect(publishRoom(environment, id, other.id, true, false)).rejects.toThrow(
    'OPERATION_CONFLICT',
  );
  expect(
    (await db.select().from(roomDirectory).where(eq(roomDirectory.id, id)))[0].closed,
  ).toBe(true);
  await registerInstanceRoom(environment, scope, id, false, {
    authorNames: {},
    band: 0,
    boundaries: [1200, 1600],
    weights: [1, 0, 0],
    categories: {},
    revision: 0,
  });
  await expect(
    registerInstanceRoom(
      environment,
      { ...scope, owner: other.owner },
      crypto.randomUUID(),
      false,
    ),
  ).rejects.toThrow('INSTANCE_NOT_FOUND');
  const definition = await roomDefinition(
    environment,
    scope,
    {
      source: 'original',
      categories: [],
      difficulties: [0, 1, 2],
      capacity: 2,
      count: 5,
      mistakes: 3,
      winMode: 'questions',
      name: '部屋',
      public: true,
      presenter: false,
      guests: false,
    },
    [{ text: '持込問題', displayAnswer: 'あ', readings: ['あ'], explanation: '' }],
    crypto.randomUUID(),
  );
  expect(definition.original).toBe(true);
  expect(definition.questions[0].answer).toBe('あ');
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ state: 'archived' })
        .where(eq(instances.id, instance.id)),
    );
  });
  await expect(
    registerInstanceRoom(environment, scope, crypto.randomUUID(), false),
  ).rejects.toThrow('INSTANCE_NOT_FOUND');
  await registerInstanceRoom(environment, scope, crypto.randomUUID(), true);
  expect(
    (
      await db
        .select()
        .from(organizationAccounts)
        .where(and(eq(organizationAccounts.subject, 'admin')))
    )[0].administrator,
  ).toBe(true);
});
