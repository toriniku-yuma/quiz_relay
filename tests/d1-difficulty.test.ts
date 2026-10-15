import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { defaultQuestionSettings, emptyQuestion } from '../src/shared/questions';
import { loadMatchDefinition } from '../src/worker/catalog/database';
import { contentHash } from '../src/worker/catalog/hash';
import { changeD1, connectD1, rowsD1 } from '../src/worker/db/d1';
import {
  difficultySamples,
  difficultyTrials,
  instances,
  matches,
  questionDifficulty,
  questionSettings,
  questionSubmissions,
  questionVersions,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { addInstance, setupOrganization } from '../src/worker/organization/database';
import { saveProfile } from '../src/worker/organization/profile';
import { updateDifficultyInstance } from '../src/worker/questions/daily';
import { wilson } from '../src/worker/questions/difficulty';
import {
  appendResultTrials,
  readDifficultyStatistics,
} from '../src/worker/questions/difficulty-statistics';
import { questionMutation } from '../src/worker/questions/write';
import { commitD1Result } from '../src/worker/results/database';
import type { ResultRecord } from '../src/worker/results/record';
import { resultFixture } from './fixtures/result';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1),
  now = Date.now();
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '難易度検証',
    instanceName: '初期対象',
  });
  await saveProfile(db, 'admin', { displayName: '管理者', revision: 0 }, 'local');
});
async function target() {
  const id = crypto.randomUUID();
  await addInstance(db, 'admin', { id, name: '難易度対象' });
  await changeD1(db, async (writes) => {
    writes.push(
      db.update(instances).set({ state: 'published' }).where(eq(instances.id, id)),
      db
        .insert(questionSettings)
        .values({ instanceId: id, config: { ...defaultQuestionSettings, mode: 'open' } }),
    );
  });
  const category = await questionMutation(db, 'admin', id, {
    operation: 'category',
    name: '通常',
  });
  const saved = await questionMutation(db, 'admin', id, {
    operation: 'save',
    input: {
      ...emptyQuestion(),
      text: '本文',
      displayAnswer: 'あ',
      readings: ['あ'],
      evidence: '根拠',
      explanation: '説明',
      categoryId: category.id,
    },
  });
  await questionMutation(db, 'admin', id, {
    operation: 'submit',
    id: saved.id,
    revision: 1,
  });
  const [instance] = await db.select().from(instances).where(eq(instances.id, id));
  const definition = await loadMatchDefinition({ GAME_D1: runtime.GAME_D1 } as Env, {
    owner: instance.owner,
    profile: 'local',
  });
  const [level] = await db
    .select()
    .from(questionDifficulty)
    .where(eq(questionDifficulty.instanceId, id));
  function records(count: number, correct = false) {
    return Array.from({ length: count }, (_, i) => {
      const { record } = resultFixture(),
        actors = Array.from(
          { length: definition.playersPerMatch },
          (_, index) => `actor-${(i % 10) * definition.playersPerMatch + index}`,
        );
      record.owner = instance.owner;
      record.definition = {
        ...record.definition,
        rulesHash: definition.rulesHash,
        selection: {
          band: 0,
          boundaries: [1200, 1600],
          weights: [1, 0, 0],
          categories: {},
          revision: 1,
        },
      };
      record.result.finishedAt = now + i;
      record.players = actors.map((actor) => ({
        ...record.players[0],
        id: actor,
        name: actor,
      }));
      record.result.winnerId = actors[0];
      record.startingRatings = Object.fromEntries(actors.map((actor) => [actor, 1000]));
      const question = definition.questions[0];
      record.completedQuestions = [
        {
          ...question,
          displayAnswer: question.displayAnswer ?? question.answer,
          readings: question.readings ?? [question.answer],
          source: question.source ?? '',
          participants: actors,
          correct,
        },
      ];
      return record;
    });
  }
  const update = (time = now) =>
    updateDifficultyInstance(db, 'local', {
      organizationId: instance.organizationId,
      instanceId: id,
      owner: instance.owner,
      now: time,
    });
  const current = async () =>
    (
      await db
        .select()
        .from(questionDifficulty)
        .where(eq(questionDifficulty.instanceId, id))
    )[0];
  return {
    id,
    instance,
    level,
    records,
    update,
    current,
    submissionId: String(saved.id),
  };
}
async function saveRecords(records: ResultRecord[]) {
  const rows = await Promise.all(
    records.map(async (record) => ({
      matchId: record.matchId,
      owner: record.owner,
      status: 'confirmed' as const,
      createdAt: new Date(record.startedAt).toISOString(),
      startedAt: new Date(record.startedAt).toISOString(),
      finishedAt: new Date(record.result.finishedAt).toISOString(),
      payloadHash: await contentHash(record),
      payload: record,
    })),
  );
  await changeD1(db, async (writes) => {
    writes.push(rowsD1(matches, rows));
    appendResultTrials(writes, records);
  });
}
it('完了試合を出題ごとに集計し、同じ試合の再送を二重に数えない', async () => {
  const t = await target(),
    [record] = t.records(1, true);
  await commitD1Result(runtime.GAME_D1, record);
  await commitD1Result(runtime.GAME_D1, record);
  const groups = await readDifficultyStatistics(db, t.instance.owner, [
    t.level.generation,
  ]);
  const players = record.players.length;
  expect(groups.get(t.level.generation)).toEqual([
    {
      band: 0,
      players,
      rulesHash: record.definition.rulesHash,
      bandRevision: 1,
      trials: 1,
      correct: 1,
      participants: players,
      ...wilson({ trials: 1, correct: 1, participants: players }),
    },
  ]);
  expect(
    await db
      .select()
      .from(difficultyTrials)
      .where(eq(difficultyTrials.owner, t.instance.owner)),
  ).toHaveLength(1);
});
it('50出題・20人以上の根拠で1段階だけ更新し、同日の再実行と新実績なしの翌日は維持する', async () => {
  const t = await target();
  await saveRecords(t.records(60));
  expect(await t.update()).toBe(1);
  expect(await t.current()).toMatchObject({
    current: 1,
    statisticsRevision: 60,
    lastDay: new Date(now).toISOString().slice(0, 10),
  });
  const first = await t.current();
  expect(await t.update()).toBe(0);
  expect(await t.update(now + 86400000)).toBe(0);
  expect((await t.current()).revision).toBe(first.revision);
  const [submission] = await db
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.id, t.submissionId));
  const [published] = await db
    .select()
    .from(questionVersions)
    .where(eq(questionVersions.questionId, submission.publishedId as string));
  expect(published.payload.difficulty).toBe(1);
  expect(published.payload.generation).toBe(t.level.generation);
});
it('固定した難易度と設定版の異なる実績を自動判定に混ぜない', async () => {
  const t = await target();
  await saveRecords(t.records(60));
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(questionDifficulty)
        .set({ fixed: true })
        .where(eq(questionDifficulty.instanceId, t.id)),
    );
  });
  expect(await t.update()).toBe(0);
  expect((await t.current()).current).toBe(0);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(questionDifficulty)
        .set({ fixed: false })
        .where(eq(questionDifficulty.instanceId, t.id)),
      db
        .update(questionSettings)
        .set({ revision: 2 })
        .where(eq(questionSettings.instanceId, t.id)),
    );
  });
  await saveRecords(t.records(1));
  expect(await t.update(now + 86400000)).toBe(0);
  expect((await t.current()).current).toBe(0);
});
it('カジュアル・途中問題・異なる実力帯の混合を集計から除く', async () => {
  const t = await target(),
    records = t.records(3);
  records[0].kind = 'casual';
  const incomplete = records[1].completedQuestions?.[0],
    ratings = records[2].startingRatings;
  if (!incomplete || !ratings) throw new Error('INVALID_FIXTURE');
  incomplete.participants = [records[1].players[0].id];
  ratings[records[2].players[1].id] = 2000;
  await saveRecords(records);
  expect(
    await db
      .select()
      .from(difficultySamples)
      .where(eq(difficultySamples.owner, t.instance.owner)),
  ).toEqual([]);
});
