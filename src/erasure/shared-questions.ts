import { and, eq, isNull, sql } from 'drizzle-orm';
import { changeD1, type Database, rowsD1 } from '../worker/db/d1.ts';
import {
  federationQuestionImports,
  federationQuestionLinks,
  instances,
  maintenanceCheckpoints,
  questionAvailability,
  questionSubmissions,
  questionVersions,
} from '../worker/db/schema.ts';

// Imported bodies are a cache. Identity/exclusion tombstones and result originals
// survive expiration; a later sync publishes a new native version.
export async function expireSharedQuestions(db: Database, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const [completed] = await db
    .select()
    .from(maintenanceCheckpoints)
    .where(eq(maintenanceCheckpoints.id, 'shared-retention'));
  // A completed day needs no business snapshot or revision retry.
  if (completed?.completedDay === day) return 0;
  return changeD1(db, async (writes) => {
    const [checkpoint] = await db
      .select()
      .from(maintenanceCheckpoints)
      .where(eq(maintenanceCheckpoints.id, 'shared-retention'));
    if (checkpoint?.completedDay === day) return 0;
    const rows = await db
      .select({
        link: federationQuestionLinks,
        row: questionSubmissions,
        owner: instances.owner,
      })
      .from(federationQuestionLinks)
      .innerJoin(
        federationQuestionImports,
        eq(federationQuestionImports.id, federationQuestionLinks.importId),
      )
      .innerJoin(
        questionSubmissions,
        eq(questionSubmissions.id, federationQuestionLinks.submissionId),
      )
      .innerJoin(instances, eq(instances.id, federationQuestionLinks.instanceId))
      .where(
        and(
          isNull(federationQuestionLinks.cachePurgedAt),
          sql`${federationQuestionLinks.lastAvailableAt}<=${now - 30 * 86400000}`,
          isNull(federationQuestionImports.attemptId),
          sql`max(${federationQuestionLinks.lastAvailableAt},case when ${federationQuestionLinks.seenSnapshot}=${federationQuestionImports.activeSnapshot} then ${federationQuestionImports.lastSuccessAt} else 0 end)<=${now - 30 * 86400000}`,
        ),
      )
      .orderBy(federationQuestionLinks.lastAvailableAt)
      .limit(25);
    if (rows.length) {
      // The database guard independently verifies the 30-day cutoff and exact erasure.
      writes.push(
        db
          .update(questionVersions)
          .set({
            payload: sql`json_remove(${questionVersions.payload},'$.text','$.answer','$.displayAnswer','$.readings','$.traps','$.explanation','$.source','$.distractors')`,
          })
          .where(
            sql`exists(select 1 from json_each(${JSON.stringify(rows.map(({ owner, row }) => ({ owner, seriesId: row.seriesId })))}) pair where json_extract(pair.value,'$.owner')=${questionVersions.owner} and json_extract(pair.value,'$.seriesId')=json_extract(${questionVersions.payload},'$.seriesId'))`,
          ),
        rowsD1(
          questionSubmissions,
          rows.map(({ row }) => ({
            ...row,
            input: {
              ...row.input,
              text: '共有停止のため未使用キャッシュを削除しました。',
              displayAnswer: '',
              readings: [],
              traps: [],
              explanation: '',
              evidence: '',
              source: '',
            },
            searchText: '共有停止のため未使用キャッシュを削除しました。',
          })),
          true,
        ),
        rowsD1(
          questionAvailability,
          rows
            .filter(({ row }) => row.publishedId)
            .map(({ owner, row }) => ({
              owner,
              questionId: row.publishedId as string,
              retiredAt: new Date(now).toISOString(),
            })),
          true,
        ),
        rowsD1(
          federationQuestionLinks,
          rows.map(({ link }) => ({ ...link, cachePurgedAt: now, sourceHash: '' })),
          true,
        ),
      );
    }
    if (rows.length)
      writes.push(
        db
          .update(federationQuestionImports)
          .set({ activeSnapshot: null, cursor: null, snapshot: null, nextAttemptAt: 0 })
          .where(
            sql`${federationQuestionImports.id} in (select value from json_each(${JSON.stringify([...new Set(rows.map((row) => row.link.importId))])}))`,
          ),
      );
    if (rows.length < 25)
      writes.push(
        db
          .insert(maintenanceCheckpoints)
          .values({ id: 'shared-retention', completedDay: day })
          .onConflictDoUpdate({
            target: maintenanceCheckpoints.id,
            set: { completedDay: day },
          }),
      );
    return rows.length;
  });
}
