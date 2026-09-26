import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  questionAvailability,
  questionSubmissions,
  questionVersions,
} from '../db/schema.ts';

type Database = Pick<PostgresJsDatabase, 'select' | 'insert' | 'update'>;
// Copy only the published payload. A pending text revision must never leak through a metadata edit.
export async function republishQuestionMetadata(
  db: Database,
  owner: string,
  row: typeof questionSubmissions.$inferSelect,
  change: { categoryId?: string; difficulty?: number },
) {
  if (!row.publishedId) return null;
  const [old] = await db
    .select()
    .from(questionVersions)
    .where(
      and(
        eq(questionVersions.owner, owner),
        eq(questionVersions.questionId, row.publishedId),
      ),
    );
  if (!old) throw new Error('PUBLISHED_QUESTION_NOT_FOUND');
  const id = crypto.randomUUID();
  await db.insert(questionVersions).values({
    owner,
    questionId: id,
    version: 1,
    payload: { ...old.payload, ...change, id },
  });
  await db.insert(questionAvailability).values({
    owner,
    questionId: id,
    retiredAt: row.stopped ? new Date().toISOString() : null,
  });
  await db
    .update(questionAvailability)
    .set({ retiredAt: new Date().toISOString() })
    .where(
      and(
        eq(questionAvailability.owner, owner),
        eq(questionAvailability.questionId, old.questionId),
      ),
    );
  await db
    .update(questionSubmissions)
    .set({ publishedId: id })
    .where(
      and(
        eq(questionSubmissions.instanceId, row.instanceId),
        eq(questionSubmissions.id, row.id),
      ),
    );
  return id;
}
