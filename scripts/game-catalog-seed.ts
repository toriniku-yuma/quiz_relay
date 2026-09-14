import { readFile } from 'node:fs/promises';
import { validateMatchConfig } from '../src/worker/catalog/config.ts';
import { validateDefinition } from '../src/worker/catalog/definition.ts';
import { contentHash } from '../src/worker/catalog/hash.ts';
import { connectDatabase } from '../src/worker/db/connection.ts';
import {
  competitions,
  questionAvailability,
  questionSetItems,
  questionSets,
  questionVersions,
  rulesetVersions,
} from '../src/worker/db/schema.ts';

async function main() {
  const [path = 'config/matchmaking.json', flag, ...extra] = process.argv.slice(2);
  if ((flag && flag !== '--apply') || extra.length) throw new Error('INVALID_ARGUMENTS');
  const config = validateMatchConfig(
    JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')),
  );
  const questions = JSON.parse(
    await readFile(
      new URL('../supabase/seeds/mock-hiragana.json', import.meta.url),
      'utf8',
    ),
  );
  const definition = await validateDefinition({
    competition: { owner: config.owner, id: config.competitionId, version: 1 },
    ruleset: { owner: config.owner, id: config.rulesetId, version: 1 },
    questionSet: { owner: config.owner, ...config.questionSet },
    playersPerMatch: config.playersPerMatch,
    rules: config.rules,
    rulesHash: await contentHash(config.rules),
    manifestHash: await contentHash(questions),
    questions,
  });
  if (flag === '--apply') {
    const url = process.env.GAME_MIGRATION_DATABASE_URL;
    if (!url) throw new Error('GAME_MIGRATION_DATABASE_URL_REQUIRED');
    const { db, close } = connectDatabase(url, process.env.DATABASE_CA_CERT);
    try {
      await db.transaction(async (tx) => {
        await tx.insert(rulesetVersions).values({
          owner: config.owner,
          rulesetId: config.rulesetId,
          version: 1,
          rulesHash: definition.rulesHash,
          config: config.rules,
        });
        await tx.insert(questionVersions).values(
          definition.questions.map((question) => ({
            owner: config.owner,
            questionId: question.id,
            version: 1,
            payload: question,
          })),
        );
        await tx.insert(questionSets).values({
          owner: config.owner,
          setId: config.questionSet.id,
          version: config.questionSet.version,
          manifestHash: definition.manifestHash,
        });
        await tx.insert(questionSetItems).values(
          definition.questions.map((question, index) => ({
            owner: config.owner,
            setId: config.questionSet.id,
            setVersion: config.questionSet.version,
            ordinal: index + 1,
            questionId: question.id,
            questionVersion: 1,
          })),
        );
        await tx.insert(questionAvailability).values(
          definition.questions.map((question) => ({
            owner: config.owner,
            questionId: question.id,
          })),
        );
        await tx.insert(competitions).values({
          owner: config.owner,
          competitionId: config.competitionId,
          version: 1,
          playersPerMatch: config.playersPerMatch,
          rulesetId: config.rulesetId,
          rulesetVersion: 1,
          setId: config.questionSet.id,
          setVersion: config.questionSet.version,
        });
      });
    } finally {
      await close();
    }
  }
  console.log(
    JSON.stringify({
      applied: flag === '--apply',
      playersPerMatch: config.playersPerMatch,
      questionCount: definition.questions.length,
      manifestHash: definition.manifestHash,
    }),
  );
}
main().catch(() => {
  console.error(
    'CATALOG_SEED_FAILED: check configuration; seed is for an empty catalog only.',
  );
  process.exitCode = 1;
});
