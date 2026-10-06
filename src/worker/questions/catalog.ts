import { and, asc, eq, max, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { contentHash } from '../catalog/hash.ts';
import {
  questionAvailability as availability,
  competitions,
  instances,
  matchmakingSettings,
  questionSetItems,
  questionSets,
  questionSettings,
  questionVersions as questions,
  rulesetVersions,
  questionSubmissions as submissions,
} from '../db/schema.ts';
import { rules } from '../game/rules.ts';

type Database = Pick<
  PostgresJsDatabase,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'
>;

// Automatic catalogs are immutable generations, just like CLI catalogs. Existing rooms retain their generation.
export async function publishQuestionCatalog(
  db: Database,
  instanceId: string,
  owner: string,
  profile: string,
  rankedPlayers?: number,
) {
  const [configuration] = await db
    .select()
    .from(questionSettings)
    .where(eq(questionSettings.instanceId, instanceId));
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner}, 0))`);
  const current = await db
    .select({
      question: questions.payload,
      availability,
      authorName: sql<string>`coalesce(${submissions.provenance}->>'author', ${submissions.authorName})`,
    })
    .from(submissions)
    .innerJoin(
      questions,
      and(
        eq(questions.owner, owner),
        eq(questions.questionId, sql`${submissions.publishedId}::text`),
      ),
    )
    .innerJoin(
      availability,
      and(
        eq(availability.owner, questions.owner),
        eq(availability.questionId, questions.questionId),
      ),
    )
    .where(eq(submissions.instanceId, instanceId))
    .orderBy(asc(submissions.id));
  const [old] = await db
    .select({ rules: rulesetVersions.config, players: competitions.playersPerMatch })
    .from(matchmakingSettings)
    .innerJoin(
      competitions,
      and(
        eq(competitions.owner, owner),
        eq(competitions.competitionId, matchmakingSettings.competitionId),
        eq(competitions.version, matchmakingSettings.competitionVersion),
      ),
    )
    .innerJoin(
      rulesetVersions,
      and(
        eq(rulesetVersions.owner, owner),
        eq(rulesetVersions.rulesetId, competitions.rulesetId),
        eq(rulesetVersions.version, competitions.rulesetVersion),
      ),
    )
    .where(
      and(eq(matchmakingSettings.owner, owner), eq(matchmakingSettings.profile, profile)),
    )
    .limit(1);
  const config = {
    ...(old?.rules ?? { ...rules, showSelections: true }),
    choiceCount: 4,
  };
  const rulesHash = await contentHash(config);
  const ruleId = 'authored';
  const [latestRule] = await db
    .select({ version: max(rulesetVersions.version) })
    .from(rulesetVersions)
    .where(and(eq(rulesetVersions.owner, owner), eq(rulesetVersions.rulesetId, ruleId)));
  const ruleVersion = (latestRule?.version ?? 0) + 1;
  await db
    .insert(rulesetVersions)
    .values({ owner, rulesetId: ruleId, version: ruleVersion, rulesHash, config });
  const [instance] = await db
    .select()
    .from(instances)
    .where(eq(instances.id, instanceId));
  for (const band of [0, 1, 2, 3]) {
    const casual = band === 3;
    const id = casual ? 'authored-casual' : `authored-band-${band}`;
    const profiles = casual
      ? [`${profile}-casual`]
      : band === 0
        ? [profile, `${profile}-band-0`]
        : [`${profile}-band-${band}`];
    const available = current
      .filter(
        (catalogEntry) =>
          catalogEntry.availability.retiredAt === null &&
          catalogEntry.question.difficulty !== undefined &&
          (casual ||
            (catalogEntry.question.difficulty <= band &&
              (configuration?.config.difficultyWeights?.[band]?.[
                catalogEntry.question.difficulty
              ] ?? 1) > 0 &&
              (configuration?.config.categoryWeights?.[
                catalogEntry.question.categoryId ?? ''
              ] ?? 1) > 0)),
      )
      .map((catalogEntry) => catalogEntry.question);
    const [latest] = await db
      .select({ version: max(competitions.version) })
      .from(competitions)
      .where(and(eq(competitions.owner, owner), eq(competitions.competitionId, id)));
    const version = (latest?.version ?? 0) + 1;
    await db.insert(questionSets).values({
      owner,
      setId: id,
      version,
      manifestHash: await contentHash(available),
      selection: {
        authorNames: configuration?.config.showAuthor
          ? Object.fromEntries(current.map((row) => [row.question.id, row.authorName]))
          : {},
        band: casual ? 2 : band,
        boundaries: configuration?.config.rankBoundaries ?? [1200, 1600],
        weights: casual
          ? [1, 1, 1]
          : (configuration?.config.difficultyWeights?.[band] ??
            [
              [1, 0, 0],
              [0.3, 0.7, 0],
              [0.1, 0.3, 0.6],
            ][band]),
        categories: casual ? {} : (configuration?.config.categoryWeights ?? {}),
        revision: configuration?.revision ?? 0,
      },
    });
    for (let start = 0; start < available.length; start += 100) {
      const chunk = available.slice(start, start + 100);
      const setId =
        start === 0 ? id : `${id}-chunk-${String(start / 100).padStart(6, '0')}`;
      if (start > 0)
        await db
          .insert(questionSets)
          .values({ owner, setId, version, manifestHash: await contentHash(chunk) });
      await db.insert(questionSetItems).values(
        chunk.map((question, index) => ({
          owner,
          setId,
          setVersion: version,
          ordinal: index + 1,
          questionId: question.id,
          questionVersion: 1,
        })),
      );
    }
    await db.insert(competitions).values({
      owner,
      competitionId: id,
      version,
      playersPerMatch: casual
        ? (instance?.casualConfig.players ?? 4)
        : (rankedPlayers ?? old?.players ?? 4),
      rulesetId: ruleId,
      rulesetVersion: ruleVersion,
      setId: id,
      setVersion: version,
    });
    for (const target of profiles)
      await db
        .insert(matchmakingSettings)
        .values({
          owner,
          profile: target,
          competitionId: id,
          competitionVersion: version,
        })
        .onConflictDoUpdate({
          target: [matchmakingSettings.owner, matchmakingSettings.profile],
          set: { competitionId: id, competitionVersion: version },
        });
  }
}
