import { and, eq, lte, sql } from 'drizzle-orm';
import { changeD1, type Database } from '../worker/db/d1.ts';
import { matches, resultPrivacyJobs } from '../worker/db/schema.ts';
import { eraseResult } from '../worker/results/database.ts';
import { privateResultSQL } from '../worker/results/privacy.ts';

function resultPrivacyPending() {
  const projection = privateResultSQL(matches.payload);
  return sql`exists(select fullkey, type, atom from json_tree(${matches.payload}) except select fullkey, type, atom from json_tree(${projection})) or exists(select fullkey, type, atom from json_tree(${projection}) except select fullkey, type, atom from json_tree(${matches.payload}))`;
}

export async function eraseResultNames(db: Database) {
  const rows = await db
    .select({ id: resultPrivacyJobs.matchId, dueAt: resultPrivacyJobs.dueAt })
    .from(resultPrivacyJobs)
    .where(lte(resultPrivacyJobs.dueAt, new Date().toISOString()))
    .orderBy(resultPrivacyJobs.dueAt, resultPrivacyJobs.matchId)
    .limit(1);
  for (const row of rows) {
    await eraseResult(db, row.id);
    await changeD1(db, async (writes) => {
      const [pending] = await db
        .select()
        .from(resultPrivacyJobs)
        .where(eq(resultPrivacyJobs.matchId, row.id));
      if (!pending || pending.dueAt !== row.dueAt) return;
      const [result] = await db.select().from(matches).where(eq(matches.matchId, row.id));
      // A concurrent withdrawal can require a fresh projection even if the receipt time matches.
      const [changed] = await db
        .select({ id: matches.matchId })
        .from(matches)
        .where(and(eq(matches.matchId, row.id), resultPrivacyPending()))
        .limit(1);
      if (changed) return;
      const now = Date.now(),
        record = result?.payload,
        dates: number[] = [];
      const endedAt = record?.result?.finishedAt ?? record?.cancelledAt;
      if (record && endedAt !== undefined) {
        if (record.players.some((player) => player.guest))
          dates.push(endedAt + 30 * 86400000);
        if (record.completedQuestions || record.questions)
          dates.push(endedAt + (record.definition.original ? 30 : 365) * 86400000);
      }
      const next = dates
        .map((time) => Math.ceil(time / 1000) * 1000)
        .filter((time) => time > now)
        .sort((left, right) => left - right)[0];
      writes.push(
        next
          ? db
              .update(resultPrivacyJobs)
              .set({ dueAt: new Date(next).toISOString() })
              .where(eq(resultPrivacyJobs.matchId, row.id))
          : db.delete(resultPrivacyJobs).where(eq(resultPrivacyJobs.matchId, row.id)),
      );
    });
  }
  return rows.length;
}
