import { readFile } from 'node:fs/promises';
import { validateMatchConfig } from '../src/worker/catalog/config.ts';
import { validateDefinition } from '../src/worker/catalog/definition.ts';
import { contentHash } from '../src/worker/catalog/hash.ts';
import { changeD1, rowBatchesD1 } from '../src/worker/db/d1.ts';
import {
  competitions,
  questionAvailability,
  questionSetItems,
  questionSets,
  questionVersions,
  rulesetVersions,
} from '../src/worker/db/schema.ts';
import { localD1 } from './local-d1.ts';

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
    const { db, close } = await localD1();
    try {
      await changeD1(db, async (writes) => {
        writes.push(
          db.insert(rulesetVersions).values({
            owner: config.owner,
            rulesetId: config.rulesetId,
            version: 1,
            rulesHash: definition.rulesHash,
            config: config.rules,
          }),
        );
        writes.push(
          ...rowBatchesD1(
            questionVersions,
            definition.questions.map((question) => ({
              owner: config.owner,
              questionId: question.id,
              version: 1,
              payload: question,
            })),
          ),
        );
        writes.push(
          db.insert(questionSets).values({
            owner: config.owner,
            setId: config.questionSet.id,
            version: config.questionSet.version,
            manifestHash: definition.manifestHash,
          }),
        );
        writes.push(
          ...rowBatchesD1(
            questionSetItems,
            definition.questions.map((question, index) => ({
              owner: config.owner,
              setId: config.questionSet.id,
              setVersion: config.questionSet.version,
              ordinal: index + 1,
              questionId: question.id,
              questionVersion: 1,
            })),
          ),
        );
        writes.push(
          ...rowBatchesD1(
            questionAvailability,
            definition.questions.map((question) => ({
              owner: config.owner,
              questionId: question.id,
            })),
          ),
        );
        writes.push(
          db.insert(competitions).values({
            owner: config.owner,
            competitionId: config.competitionId,
            version: 1,
            playersPerMatch: config.playersPerMatch,
            rulesetId: config.rulesetId,
            rulesetVersion: 1,
            setId: config.questionSet.id,
            setVersion: config.questionSet.version,
          }),
        );
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
