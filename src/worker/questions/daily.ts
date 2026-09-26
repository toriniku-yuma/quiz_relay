import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  competitions,
  matchmakingSettings,
  questionDifficulty,
  questionSettings,
  questionSubmissionEvents,
  questionSubmissions,
  rulesetVersions,
} from '../db/schema.ts';
import type { ResultRecord } from '../results/record.ts';
import { publishQuestionCatalog } from './catalog.ts';
import { estimateDifficulty } from './difficulty.ts';
import { republishQuestionMetadata } from './metadata.ts';
import { questionStatistics } from './statistics.ts';

export async function updateDifficultyInstance(
  db: PostgresJsDatabase,
  profile: string,
  input: {
    organizationId: string;
    instanceId: string;
    owner: string;
    records: ResultRecord[];
    rulesHash?: string;
    players?: number;
    now: number;
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${input.instanceId}`}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.owner}, 0))`,
    );
    await tx.execute(
      sql`select set_config('quiz.organization_id', ${input.organizationId}, true)`,
    );
    const [active] = await tx
      .select({
        players: competitions.playersPerMatch,
        rulesHash: rulesetVersions.rulesHash,
      })
      .from(matchmakingSettings)
      .innerJoin(
        competitions,
        and(
          eq(competitions.owner, input.owner),
          eq(competitions.competitionId, matchmakingSettings.competitionId),
          eq(competitions.version, matchmakingSettings.competitionVersion),
        ),
      )
      .innerJoin(
        rulesetVersions,
        and(
          eq(rulesetVersions.owner, input.owner),
          eq(rulesetVersions.rulesetId, competitions.rulesetId),
          eq(rulesetVersions.version, competitions.rulesetVersion),
        ),
      )
      .where(
        and(
          eq(matchmakingSettings.owner, input.owner),
          eq(matchmakingSettings.profile, profile),
        ),
      );
    const players = input.players ?? active?.players;
    const rulesHash = input.rulesHash ?? active?.rulesHash;
    if (!players || !rulesHash) return 0;
    const day = new Date(input.now).toISOString().slice(0, 10);
    const [configuration] = await tx
      .select()
      .from(questionSettings)
      .where(eq(questionSettings.instanceId, input.instanceId));
    let changed = 0;
    for (const current of await tx
      .select()
      .from(questionDifficulty)
      .where(eq(questionDifficulty.instanceId, input.instanceId))) {
      if (current.lastDay === day) continue;
      const stats = questionStatistics(input.records, current.generation);
      const cursor = JSON.stringify(stats);
      if (cursor === current.cursor) continue;
      const samples = [0, 1, 2].map((band) =>
        stats.find(
          (sample) =>
            sample.band === band &&
            sample.players === players &&
            sample.rulesHash === rulesHash &&
            sample.bandRevision === (configuration?.revision ?? 0),
        ),
      );
      const decision = estimateDifficulty(current.current, samples, current.fixed);
      const [row] = await tx
        .select()
        .from(questionSubmissions)
        .where(
          and(
            eq(questionSubmissions.instanceId, input.instanceId),
            eq(questionSubmissions.seriesId, current.seriesId),
          ),
        );
      if (!row) continue;
      await tx
        .update(questionDifficulty)
        .set({
          stats,
          cursor,
          lastDay: day,
          current: decision.current,
          reason: decision.reason,
          revision: current.revision + 1,
        })
        .where(
          and(
            eq(questionDifficulty.instanceId, input.instanceId),
            eq(questionDifficulty.seriesId, current.seriesId),
            eq(questionDifficulty.revision, current.revision),
          ),
        );
      if (current.current !== decision.current) {
        await republishQuestionMetadata(tx, input.owner, row, {
          difficulty: decision.current,
        });
        await tx.insert(questionSubmissionEvents).values({
          id: crypto.randomUUID(),
          instanceId: input.instanceId,
          submissionId: row.id,
          revision: row.revision,
          actorId: 'system:difficulty',
          action: 'automatic-difficulty',
          input: row.input,
          reason: JSON.stringify({
            day,
            before: current.current,
            after: decision.current,
            cursor,
            settingsRevision: configuration?.revision ?? 0,
            formula: 'wilson95-v1',
            reason: decision.reason,
          }),
        });
        changed++;
      }
    }
    if (changed) await publishQuestionCatalog(tx, input.instanceId, input.owner, profile);
    return changed;
  });
}
