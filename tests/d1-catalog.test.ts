import { applyD1Migrations, env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import configuration from '../config/matchmaking.local.json';
import { loadFixedVersion, loadMatchDefinition } from '../src/worker/catalog/database';
import { contentHash } from '../src/worker/catalog/hash';
import { publishMatchConfig } from '../src/worker/catalog/publish';
import { changeD1, connectD1, rowsD1 } from '../src/worker/db/d1';
import {
  competitions,
  questionAvailability,
  questionSetItems,
  questionSets,
  questionVersions,
  rulesetVersions,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { questions } from './fixtures/questions';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
beforeAll(() => applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS));

async function catalog() {
  const owner = `https://catalog-${crypto.randomUUID()}.test`;
  const selected = questions.slice(0, 10);
  const manifestHash = await contentHash(selected);
  await changeD1(db, async (writes) => {
    writes.push(
      rowsD1(
        questionVersions,
        selected.map((question) => ({
          owner,
          questionId: question.id,
          version: 1,
          payload: question,
        })),
      ),
      rowsD1(
        questionAvailability,
        selected.map((question) => ({ owner, questionId: question.id, retiredAt: null })),
      ),
      db
        .insert(questionSets)
        .values({ owner, setId: configuration.questionSet.id, version: 1, manifestHash }),
      rowsD1(
        questionSetItems,
        selected.map((question, index) => ({
          owner,
          setId: configuration.questionSet.id,
          setVersion: 1,
          ordinal: index + 1,
          questionId: question.id,
          questionVersion: 1,
        })),
      ),
    );
  });
  const config = { ...configuration, owner };
  const environment = { GAME_D1: runtime.GAME_D1 } as Env;
  const active = { owner, profile: 'local' };
  return { owner, selected, config, environment, active };
}

it('D1で出題設定を反映し、解答を含む有効カタログのhashと順序を検証する', async () => {
  const { config, environment, active, selected } = await catalog();
  const saved = await publishMatchConfig(db, config, 'local');
  expect(saved.version).toBe(1);
  const definition = await loadMatchDefinition(environment, active);
  expect(definition.questions).toEqual(selected);
  expect(definition.playersPerMatch).toBe(2);
  expect(definition.rules).toEqual(config.rules);
  expect(definition.manifestHash).toBe(await contentHash(selected));
});

it('同時反映・再送で過去版を増やさず、人数変更は新しい大会版だけに反映する', async () => {
  const { owner, config, environment, active } = await catalog();
  const saved = await Promise.all([
    publishMatchConfig(db, config, 'local'),
    publishMatchConfig(db, config, 'local'),
  ]);
  expect(saved.map((entry) => entry.version)).toEqual([1, 1]);
  expect(
    await db.select().from(competitions).where(eq(competitions.owner, owner)),
  ).toHaveLength(1);
  expect(
    await db.select().from(rulesetVersions).where(eq(rulesetVersions.owner, owner)),
  ).toHaveLength(1);
  await publishMatchConfig(db, { ...config, playersPerMatch: 4 }, 'local');
  expect((await loadMatchDefinition(environment, active)).playersPerMatch).toBe(4);
  expect(
    (
      await loadFixedVersion(environment, {
        owner,
        id: config.competitionId,
        version: 1,
      })
    ).playersPerMatch,
  ).toBe(2);
});

it('問題の停止後は古いセット経由でも新規開始と設定反映を拒否する', async () => {
  const { owner, config, environment, active, selected } = await catalog();
  await publishMatchConfig(db, config, 'local');
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(questionAvailability)
        .set({ retiredAt: new Date().toISOString() })
        .where(
          and(
            eq(questionAvailability.owner, owner),
            eq(questionAvailability.questionId, selected[0].id),
          ),
        ),
    );
  });
  await expect(loadMatchDefinition(environment, active)).rejects.toThrow(
    'QUESTION_UNAVAILABLE',
  );
  await expect(
    publishMatchConfig(db, { ...config, playersPerMatch: 4 }, 'local'),
  ).rejects.toThrow('QUESTION_UNAVAILABLE');
  expect(
    await db.select().from(competitions).where(eq(competitions.owner, owner)),
  ).toHaveLength(1);
});

it('待機時に固定した版は問題の停止後も開始前検証で読める', async () => {
  const { owner, config, environment, active } = await catalog();
  await publishMatchConfig(db, config, 'local');
  const fixed = await loadMatchDefinition(environment, active);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(questionAvailability)
        .set({ retiredAt: new Date().toISOString() })
        .where(eq(questionAvailability.owner, owner)),
    );
  });

  await expect(loadMatchDefinition(environment, active)).rejects.toThrow(
    'NO_RANKED_QUESTIONS',
  );
  expect(await loadFixedVersion(environment, fixed.competition)).toEqual({
    playersPerMatch: fixed.playersPerMatch,
    rulesHash: fixed.rulesHash,
  });
  await expect(
    loadFixedVersion(environment, { ...fixed.competition, version: 99 }),
  ).rejects.toThrow('DEFINITION_NOT_FOUND');
});

it('出題版・セット・項目・ルール・大会の原本をSQLからも改変・削除できない', async () => {
  const { owner, config } = await catalog();
  await publishMatchConfig(db, config, 'local');
  for (const table of [
    'quiz_game_question_versions',
    'quiz_game_question_sets',
    'quiz_game_question_set_items',
    'quiz_game_ruleset_versions',
    'quiz_game_competitions',
  ]) {
    await expect(
      runtime.GAME_D1.prepare(`update ${table} set owner = ? where owner = ?`)
        .bind('https://changed.test', owner)
        .run(),
    ).rejects.toThrow('IMMUTABLE_CATALOG');
    await expect(
      runtime.GAME_D1.prepare(`delete from ${table} where owner = ?`).bind(owner).run(),
    ).rejects.toThrow('IMMUTABLE_CATALOG');
  }
});
