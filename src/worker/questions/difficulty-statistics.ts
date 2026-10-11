import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { changeD1, type D1Write, type Database, rowBatchesD1 } from '../db/d1.ts';
import {
  difficultyActors,
  difficultyBackfills,
  difficultySamples,
  difficultyTrials,
  matchResults,
  type questionDifficulty,
} from '../db/schema.ts';
import type { ResultRecord } from '../results/record.ts';
import { wilson } from './difficulty.ts';

export function resultTrials(
  record: ResultRecord,
): (typeof difficultyTrials.$inferInsert)[] {
  const selection = record.definition.selection,
    ratings = record.startingRatings;
  if (record.kind !== 'ranked' || !selection || !ratings) return [];
  const seen = new Set<string>();
  return (record.completedQuestions ?? []).flatMap((question) => {
    if (
      !question.generation ||
      seen.has(question.id) ||
      question.participants.length < 2 ||
      new Set(question.participants).size !== question.participants.length ||
      question.participants.some((actor) => !Number.isFinite(ratings[actor]))
    )
      return [];
    seen.add(question.id);
    const bands = question.participants.map((actor) =>
      ratings[actor] < selection.boundaries[0]
        ? 0
        : ratings[actor] < selection.boundaries[1]
          ? 1
          : 2,
    );
    if (new Set(bands).size !== 1) return [];
    return [
      {
        owner: record.owner,
        matchId: record.matchId,
        resultId: record.result.id,
        questionId: question.id,
        generation: question.generation,
        band: bands[0],
        players: question.participants.length,
        rulesHash: record.definition.rulesHash,
        bandRevision: selection.revision,
        correct: question.correct,
        actors: question.participants,
      },
    ];
  });
}
export function appendResultTrials(writes: D1Write[], records: ResultRecord[]) {
  const trials = records.flatMap(resultTrials);
  if (trials.length) writes.push(...rowBatchesD1(difficultyTrials, trials, 'ignore'));
}

export async function readDifficultyStatistics(
  db: Database,
  owner: string,
  generations: string[],
) {
  type Sample = typeof difficultySamples.$inferSelect & { participants: number };
  const rows = generations.length
    ? await db
        .select({
          owner: difficultySamples.owner,
          generation: difficultySamples.generation,
          band: difficultySamples.band,
          players: difficultySamples.players,
          rulesHash: difficultySamples.rulesHash,
          bandRevision: difficultySamples.bandRevision,
          trials: difficultySamples.trials,
          correct: difficultySamples.correct,
          participants: sql<number>`(select count(*) from ${difficultyActors} where ${difficultyActors.owner}=${difficultySamples.owner} and ${difficultyActors.generation}=${difficultySamples.generation} and ${difficultyActors.band}=${difficultySamples.band} and ${difficultyActors.players}=${difficultySamples.players} and ${difficultyActors.rulesHash}=${difficultySamples.rulesHash} and ${difficultyActors.bandRevision}=${difficultySamples.bandRevision})`,
        })
        .from(difficultySamples)
        .where(
          and(
            eq(difficultySamples.owner, owner),
            sql`${difficultySamples.generation} in (select value from json_each(${JSON.stringify(generations)}))`,
          ),
        )
        .orderBy(
          difficultySamples.band,
          difficultySamples.players,
          difficultySamples.rulesHash,
          difficultySamples.bandRevision,
        )
    : ([] as Sample[]);
  const groups = new Map<string, typeof questionDifficulty.$inferSelect.stats>();
  for (const { generation, owner: _owner, ...sample } of rows) {
    const list = groups.get(generation) ?? [];
    list.push({ ...sample, ...wilson(sample) });
    groups.set(generation, list);
  }
  return groups;
}

// A one-time, five-result page for legacy data. New commits already write their trial facts.
export async function backfillDifficulty(db: Database, owner: string) {
  return changeD1(db, async (writes) => {
    const [previous] = await db
      .select()
      .from(difficultyBackfills)
      .where(eq(difficultyBackfills.owner, owner));
    if (previous?.complete) return true;
    const records = await db
      .select()
      .from(matchResults)
      .where(
        and(
          eq(matchResults.owner, owner),
          previous
            ? or(
                gt(matchResults.finishedAt, previous.finishedAt),
                and(
                  eq(matchResults.finishedAt, previous.finishedAt),
                  gt(matchResults.resultId, previous.resultId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(matchResults.finishedAt), asc(matchResults.resultId))
      .limit(5);
    appendResultTrials(
      writes,
      records.map((row) => row.payload),
    );
    const last = records.at(-1);
    writes.push(
      db
        .insert(difficultyBackfills)
        .values({
          owner,
          finishedAt: last?.finishedAt ?? previous?.finishedAt ?? '',
          resultId: last?.resultId ?? previous?.resultId ?? '',
          complete: records.length < 5,
        })
        .onConflictDoUpdate({
          target: difficultyBackfills.owner,
          set: {
            finishedAt: last?.finishedAt ?? previous?.finishedAt ?? '',
            resultId: last?.resultId ?? previous?.resultId ?? '',
            complete: records.length < 5,
          },
        }),
    );
    return records.length < 5;
  });
}
