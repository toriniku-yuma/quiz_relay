import { and, eq, sql } from 'drizzle-orm';
import { type D1Write, type Database, rowBatchesD1 } from '../db/d1.ts';
import {
  difficultyActors,
  difficultySamples,
  difficultyTrials,
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
