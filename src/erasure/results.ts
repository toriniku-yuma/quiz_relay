import { sql } from 'drizzle-orm';
import { contentHash } from '../worker/catalog/hash.ts';
import type { connectDatabase } from '../worker/db/connection.ts';
import { matchResults } from '../worker/db/schema.ts';
import type { ResultRecord } from '../worker/results/record.ts';
import { erasureBatch } from './limits.ts';

export async function eraseResultNames(
  db: Pick<ReturnType<typeof connectDatabase>['db'], 'select' | 'execute'>,
) {
  const rows = await db
    .select({
      id: matchResults.resultId,
      payload: sql<ResultRecord>`quiz_game.private_result(${matchResults.payload})`,
    })
    .from(matchResults)
    .where(
      sql`${matchResults.payload} IS DISTINCT FROM quiz_game.private_result(${matchResults.payload})`,
    )
    .limit(erasureBatch.results);
  for (const row of rows)
    await db.execute(
      sql`select quiz_game.erase_result_names(${row.id}::uuid, ${JSON.stringify(row.payload)}::jsonb, ${await contentHash(row.payload)})`,
    );
  return rows.length;
}
