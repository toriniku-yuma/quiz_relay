import type { ResultRecord } from '../results/record.ts';
import { wilson } from './difficulty.ts';

// Read-only computation. Scheduling and database writes are separate from this module.
export function questionStatistics(records: ResultRecord[], generation: string) {
  const groups = new Map<
    string,
    {
      band: number;
      players: number;
      rulesHash: string;
      bandRevision: number;
      trials: number;
      correct: number;
      actors: Set<string>;
    }
  >();
  const seen = new Set<string>();
  for (const record of records) {
    const selection = record.definition.selection;
    const ratings = record.startingRatings;
    if (record.kind !== 'ranked' || !selection || !ratings) continue;
    for (const question of record.completedQuestions ?? []) {
      if (
        question.generation !== generation ||
        question.participants.length < 2 ||
        question.participants.some((actor) => !Number.isFinite(ratings[actor]))
      )
        continue;
      const identity = `${record.owner}:${record.matchId}:${question.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const bands = question.participants.map((actor) =>
        ratings[actor] < selection.boundaries[0]
          ? 0
          : ratings[actor] < selection.boundaries[1]
            ? 1
            : 2,
      );
      if (new Set(bands).size !== 1) continue;
      const band = bands[0];
      const players = question.participants.length;
      const key = `${band}:${players}:${record.definition.rulesHash}:${selection.revision}`;
      const group = groups.get(key) ?? {
        band,
        players,
        rulesHash: record.definition.rulesHash,
        bandRevision: selection.revision,
        trials: 0,
        correct: 0,
        actors: new Set<string>(),
      };
      group.trials++;
      if (question.correct) group.correct++;
      for (const actor of question.participants) group.actors.add(actor);
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(({ actors, ...group }) => ({
    ...group,
    participants: actors.size,
    ...wilson({ ...group, participants: actors.size }),
  }));
}
