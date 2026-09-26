import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { updateDifficultyInstance } from '../src/worker/questions/daily.ts';

// One-shot isolated verification. No production timer or deployment configuration is changed.
export async function verifyLocalDifficultyUpdate(
  db: PostgresJsDatabase,
  address: string,
  input: Parameters<typeof updateDifficultyInstance>[2],
) {
  const target = new URL(address);
  if (
    target.hostname !== '127.0.0.1' ||
    target.port !== '55439' ||
    target.pathname !== '/quiz_relay_questions_test'
  )
    throw new Error('ISOLATED_QUESTION_DATABASE_REQUIRED');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
    return updateDifficultyInstance(tx, 'local', input);
  });
}
