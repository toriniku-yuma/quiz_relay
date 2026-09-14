import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { and, count, eq, inArray } from 'drizzle-orm';
import { publishMatchConfig } from '../src/worker/catalog/publish.ts';
import { connectDatabase } from '../src/worker/db/connection.ts';
import {
  competitions,
  matchmakingSettings,
  questionAvailability,
  questionVersions,
  rulesetVersions,
} from '../src/worker/db/schema.ts';

if (!process.env.GAME_MIGRATION_DATABASE_URL || !process.env.GAME_CONFIG_DATABASE_URL)
  throw new Error('ADMIN_AND_CONFIG_DATABASE_REQUIRED');
const admin = connectDatabase(
  process.env.GAME_MIGRATION_DATABASE_URL,
  process.env.DATABASE_CA_CERT,
);
const writer = connectDatabase(
  process.env.GAME_CONFIG_DATABASE_URL,
  process.env.DATABASE_CA_CERT,
);
const secondWriter = connectDatabase(
  process.env.GAME_CONFIG_DATABASE_URL,
  process.env.DATABASE_CA_CERT,
);
const config = JSON.parse(await readFile('config/matchmaking.local.json', 'utf8'));
const suffix = crypto.randomUUID().replaceAll('-', '');
const profiles = [`qa_${suffix}_a`, `qa_${suffix}_b`];
const totals = async () => {
  const [rules] = await admin.db.select({ n: count() }).from(rulesetVersions);
  const [matches] = await admin.db.select({ n: count() }).from(competitions);
  return [rules.n, matches.n];
};
const denied = (error) => (error.cause?.code ?? error.code) === '42501';
try {
  const before = await totals();
  const rollback = new Error('TEST_ROLLBACK');
  await assert.rejects(
    writer.db.transaction(async (tx) => {
      const modified = {
        ...config,
        rulesetId: `qa_${suffix}`,
        playersPerMatch: 3,
        rules: {
          ...config.rules,
          correctAnswersToWin: 5,
          mistakesToDisqualify: 2,
          reconnectGraceMs: 20000,
        },
      };
      const first = await publishMatchConfig(tx, modified, profiles[0]);
      const repeated = await publishMatchConfig(tx, modified, profiles[0]);
      assert.deepEqual(first, repeated);
      const [saved] = await tx
        .select()
        .from(competitions)
        .where(
          and(
            eq(competitions.owner, config.owner),
            eq(competitions.competitionId, config.competitionId),
            eq(competitions.version, first.version),
          ),
        );
      assert.equal(saved.playersPerMatch, 3);
      const [rules] = await tx
        .select()
        .from(rulesetVersions)
        .where(
          and(
            eq(rulesetVersions.owner, config.owner),
            eq(rulesetVersions.rulesetId, modified.rulesetId),
            eq(rulesetVersions.version, saved.rulesetVersion),
          ),
        );
      assert.equal(rules.config.correctAnswersToWin, 5);
      assert.equal(rules.config.mistakesToDisqualify, 2);
      assert.equal(rules.config.reconnectGraceMs, 20000);
      const [ruleCount] = await tx.select({ n: count() }).from(rulesetVersions);
      const [matchCount] = await tx.select({ n: count() }).from(competitions);
      assert.equal(ruleCount.n, before[0] + 1);
      assert.equal(matchCount.n, before[1] + 1);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.deepEqual(await totals(), before);
  const concurrent = await Promise.all([
    publishMatchConfig(writer.db, config, profiles[0]),
    publishMatchConfig(secondWriter.db, config, profiles[1]),
  ]);
  assert.equal(concurrent[0].version, concurrent[1].version);
  assert.deepEqual(await totals(), before);
  // Supplied strings never become SQL, and bad definitions never publish a profile.
  await assert.rejects(
    publishMatchConfig(
      writer.db,
      { ...config, competitionId: "bad';drop table x;--" },
      profiles[0],
    ),
  );
  await assert.rejects(
    publishMatchConfig(
      writer.db,
      { ...config, questionSet: { id: 'missing', version: 1 } },
      profiles[0],
    ),
  );
  await assert.rejects(
    writer.db
      .update(rulesetVersions)
      .set({ version: 1 })
      .where(eq(rulesetVersions.owner, 'https://qa.invalid')),
    denied,
  );
  await assert.rejects(
    writer.db.delete(competitions).where(eq(competitions.owner, 'https://qa.invalid')),
    denied,
  );
  await assert.rejects(
    writer.db
      .update(questionAvailability)
      .set({ retiredAt: null })
      .where(eq(questionAvailability.owner, 'https://qa.invalid')),
    denied,
  );
  await assert.rejects(
    writer.db
      .delete(questionVersions)
      .where(eq(questionVersions.owner, 'https://qa.invalid')),
    denied,
  );
  const [originalRule] = await admin.db
    .select()
    .from(rulesetVersions)
    .where(
      and(
        eq(rulesetVersions.owner, config.owner),
        eq(rulesetVersions.rulesetId, config.rulesetId),
      ),
    )
    .limit(1);
  await assert.rejects(
    admin.db.transaction((tx) =>
      tx
        .update(rulesetVersions)
        .set({ version: originalRule.version })
        .where(
          and(
            eq(rulesetVersions.owner, originalRule.owner),
            eq(rulesetVersions.rulesetId, originalRule.rulesetId),
            eq(rulesetVersions.version, originalRule.version),
          ),
        ),
    ),
    (error) => (error.cause?.message ?? error.message) === 'IMMUTABLE_VERSION',
  );
  console.log(
    'PASS: Drizzle publish, new immutable versions, rollback, repeat/concurrent reuse, invalid input and writer restrictions',
  );
} catch {
  console.error('GAME_DATABASE_CHECK_FAILED');
  process.exitCode = 1;
} finally {
  try {
    await admin.db
      .delete(matchmakingSettings)
      .where(inArray(matchmakingSettings.profile, profiles));
  } finally {
    await Promise.all([admin.close(), writer.close(), secondWriter.close()]);
  }
}
