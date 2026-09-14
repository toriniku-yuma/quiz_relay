import { loadMatchDefinition } from '../src/worker/catalog/database.ts';
import type { Env } from '../src/worker/env.ts';

const [owner, id, version] = process.argv.slice(2);
try {
  const definition = await loadMatchDefinition(
    {
      GAME_DATABASE_URL: process.env.GAME_DATABASE_URL,
      DATABASE_CA_CERT: process.env.DATABASE_CA_CERT,
    } as Env,
    { owner, id, version: Number(version) },
  );
  console.log(
    JSON.stringify({
      verified: true,
      competition: definition.competition,
      playersPerMatch: definition.playersPerMatch,
      questionCount: definition.questions.length,
      rulesHash: definition.rulesHash,
      manifestHash: definition.manifestHash,
    }),
  );
} catch {
  // DB例外には接続情報・クエリが含まれ得る。値や生の例外を出力しない。
  console.error(
    'CATALOG_CHECK_FAILED: check arguments, game DB configuration and applied migrations/seed.',
  );
  process.exitCode = 1;
}
