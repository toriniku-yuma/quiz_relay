import { and, eq, sql } from 'drizzle-orm';
import { changeD1, type Database } from '../db/d1.ts';
import {
  competitions,
  difficultySamples,
  instances,
  matchmakingSettings,
  questionDifficulty,
  questionSettings,
  questionSubmissions,
  rulesetVersions,
} from '../db/schema.ts';
import { publishQuestionCatalog } from './catalog.ts';
import { estimateDifficulty } from './difficulty.ts';
import { backfillDifficulty, readDifficultyStatistics } from './difficulty-statistics.ts';
import { QuestionPlan } from './plan.ts';

export async function updateDifficultyInstance(
  db: Database,
  profile: string,
  input: { organizationId: string; instanceId: string; owner: string; now: number },
) {
  if (!(await backfillDifficulty(db, input.owner))) return 0;
  const day = new Date(input.now).toISOString().slice(0, 10);
  return changeD1(db, async (writes) => {
    const [scope] = await db
      .select()
      .from(instances)
      .where(
        and(
          eq(instances.id, input.instanceId),
          eq(instances.organizationId, input.organizationId),
          eq(instances.owner, input.owner),
        ),
      );
    if (!scope || scope.state === 'archived') return 0;
    const [active] = await db
      .select({
        players: competitions.playersPerMatch,
        rulesHash: rulesetVersions.rulesHash,
      })
      .from(matchmakingSettings)
      .innerJoin(
        competitions,
        and(
          eq(competitions.owner, matchmakingSettings.owner),
          eq(competitions.competitionId, matchmakingSettings.competitionId),
          eq(competitions.version, matchmakingSettings.competitionVersion),
        ),
      )
      .innerJoin(
        rulesetVersions,
        and(
          eq(rulesetVersions.owner, competitions.owner),
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
    if (!active) return 0;
    const [configuration] = await db
      .select()
      .from(questionSettings)
      .where(eq(questionSettings.instanceId, input.instanceId));
    const pending = await db
      .select({ level: questionDifficulty, submissionId: questionSubmissions.id })
      .from(questionDifficulty)
      .innerJoin(
        questionSubmissions,
        and(
          eq(questionSubmissions.instanceId, questionDifficulty.instanceId),
          eq(questionSubmissions.seriesId, questionDifficulty.seriesId),
        ),
      )
      .where(
        and(
          eq(questionDifficulty.instanceId, input.instanceId),
          sql`(${questionDifficulty.lastDay} is null or ${questionDifficulty.lastDay} <> ${day})`,
          sql`${questionDifficulty.statisticsRevision} <> coalesce((select sum(${difficultySamples.trials}) from ${difficultySamples} where ${difficultySamples.owner}=${input.owner} and ${difficultySamples.generation}=${questionDifficulty.generation}),0)`,
        ),
      )
      .orderBy(questionDifficulty.seriesId)
      .limit(25);
    if (!pending.length) return 0;
    const plan = new QuestionPlan(input.instanceId, input.owner);
    await plan.load(db, {
      operation: 'automatic-difficulty',
      ids: pending.map((row) => row.submissionId),
    });
    const groups = await readDifficultyStatistics(
      db,
      input.owner,
      pending.map((row) => row.level.generation),
    );
    let changed = 0;
    for (const { level, submissionId } of pending) {
      const stats = groups.get(level.generation) ?? [],
        cursor = JSON.stringify(stats),
        row = plan.submissions.get(submissionId);
      if (!row) continue;
      const samples = [0, 1, 2].map((band) =>
        stats.find(
          (sample) =>
            sample.band === band &&
            sample.players === active.players &&
            sample.rulesHash === active.rulesHash &&
            sample.bandRevision === (configuration?.revision ?? 0),
        ),
      );
      const decision = estimateDifficulty(level.current, samples, level.fixed);
      plan.changedDifficulty.set(level.seriesId, {
        ...level,
        stats,
        cursor,
        lastDay: day,
        statisticsRevision: stats.reduce((total, sample) => total + sample.trials, 0),
        current: decision.current,
        reason: decision.reason,
        revision: level.revision + 1,
      });
      if (level.current !== decision.current) {
        const updated = plan.metadata(row, { difficulty: decision.current });
        plan.events.push({
          id: crypto.randomUUID(),
          instanceId: input.instanceId,
          submissionId: updated.id,
          revision: updated.revision,
          actorId: 'system:difficulty',
          action: 'automatic-difficulty',
          input: updated.input,
          reason: JSON.stringify({
            day,
            before: level.current,
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
    plan.flush(writes);
    if (changed)
      await publishQuestionCatalog(
        db,
        writes,
        input.instanceId,
        input.owner,
        profile,
        undefined,
        {
          submissions: [...plan.changedSubmissions.values()],
          questions: plan.newVersions,
          availability: [...plan.availability.values()],
        },
      );
    return changed;
  });
}
