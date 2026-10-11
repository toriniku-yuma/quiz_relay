import { and, eq, lte, sql } from 'drizzle-orm';
import { changeD1, type Database } from '../worker/db/d1.ts';
import { matchResults, resultPrivacyJobs } from '../worker/db/schema.ts';
import { eraseResult } from '../worker/results/database.ts';
import { privateResultSQL } from '../worker/results/privacy.ts';

export function resultPrivacyPending() {
  const projection = privateResultSQL(matchResults.payload);
  return sql`exists(select fullkey, type, atom from json_tree(${matchResults.payload}) except select fullkey, type, atom from json_tree(${projection})) or exists(select fullkey, type, atom from json_tree(${projection}) except select fullkey, type, atom from json_tree(${matchResults.payload}))`;
}

export async function eraseResultNames(db: Database) {
  const rows = await db
    .select({ id: resultPrivacyJobs.resultId, dueAt: resultPrivacyJobs.dueAt })
    .from(resultPrivacyJobs)
    .where(lte(resultPrivacyJobs.dueAt, new Date().toISOString()))
    .orderBy(resultPrivacyJobs.dueAt, resultPrivacyJobs.resultId)
    .limit(1);
  for (const row of rows) {
    await eraseResult(db, row.id);
    await changeD1(db, async (writes) => {
      const [pending] = await db
        .select()
        .from(resultPrivacyJobs)
        .where(eq(resultPrivacyJobs.resultId, row.id));
      if (!pending || pending.dueAt !== row.dueAt) return;
      const [result] = await db
        .select()
        .from(matchResults)
        .where(eq(matchResults.resultId, row.id));
      // A concurrent withdrawal can require a fresh projection even if the receipt time matches.
      const [changed] = await db
        .select({ id: matchResults.resultId })
        .from(matchResults)
        .where(and(eq(matchResults.resultId, row.id), resultPrivacyPending()))
        .limit(1);
      if (changed) return;
      const now = Date.now(),
        record = result?.payload,
        dates: number[] = [];
      if (record?.players.some((player) => player.guest))
        dates.push(record.result.finishedAt + 30 * 86400000);
      if (record?.completedQuestions)
        dates.push(
          record.result.finishedAt + (record.definition.original ? 30 : 365) * 86400000,
        );
      const next = dates
        .map((time) => Math.ceil(time / 1000) * 1000)
        .filter((time) => time > now)
        .sort((left, right) => left - right)[0];
      writes.push(
        next
          ? db
              .update(resultPrivacyJobs)
              .set({ dueAt: new Date(next).toISOString() })
              .where(eq(resultPrivacyJobs.resultId, row.id))
          : db.delete(resultPrivacyJobs).where(eq(resultPrivacyJobs.resultId, row.id)),
      );
    });
  }
  return rows.length;
}
