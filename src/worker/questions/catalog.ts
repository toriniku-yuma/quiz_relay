import { and, asc, eq, max, sql } from 'drizzle-orm';
import type { CasualSettings } from '../../shared/rooms.ts';
import { contentHash } from '../catalog/hash.ts';
import { type D1Write, type Database, rowsD1 } from '../db/d1.ts';
import {
  competitions,
  instances,
  matchmakingSettings,
  questionAvailability,
  questionSetItems,
  questionSets,
  questionSettings,
  questionSubmissions,
  questionVersions,
  rulesetVersions,
} from '../db/schema.ts';
import { rules } from '../game/rules.ts';

// Explicit pending question rows let a single native batch publish their catalog.
type CatalogChanges = {
  submissions?: (typeof questionSubmissions.$inferSelect)[];
  questions?: (typeof questionVersions.$inferInsert)[];
  availability?: (typeof questionAvailability.$inferInsert)[];
  configuration?: Pick<typeof questionSettings.$inferSelect, 'config' | 'revision'>;
  casualConfig?: CasualSettings;
};

export async function publishQuestionCatalog(
  db: Database,
  writes: D1Write[],
  instanceId: string,
  owner: string,
  profile: string,
  rankedPlayers?: number,
  changes: CatalogChanges = {},
) {
  const [storedConfiguration] = await db
    .select()
    .from(questionSettings)
    .where(eq(questionSettings.instanceId, instanceId));
  const configuration = changes.configuration ?? storedConfiguration;
  const stored = await db
    .select({
      submission: questionSubmissions,
      question: questionVersions.payload,
      availability: questionAvailability,
    })
    .from(questionSubmissions)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.owner, owner),
        eq(questionVersions.questionId, questionSubmissions.publishedId),
      ),
    )
    .innerJoin(
      questionAvailability,
      and(
        eq(questionAvailability.owner, questionVersions.owner),
        eq(questionAvailability.questionId, questionVersions.questionId),
      ),
    )
    .where(eq(questionSubmissions.instanceId, instanceId))
    .orderBy(asc(questionSubmissions.id));
  const current = new Map(stored.map((row) => [row.submission.id, row]));
  for (const submission of changes.submissions ?? []) {
    if (submission.instanceId !== instanceId) continue;
    if (!submission.publishedId) {
      current.delete(submission.id);
      continue;
    }
    const question =
      changes.questions?.find(
        (row) => row.owner === owner && row.questionId === submission.publishedId,
      )?.payload ??
      stored.find((row) => row.question.id === submission.publishedId)?.question;
    const availability =
      changes.availability?.find(
        (row) => row.owner === owner && row.questionId === submission.publishedId,
      ) ?? stored.find((row) => row.question.id === submission.publishedId)?.availability;
    if (!question || !availability) throw new Error('PUBLISHED_QUESTION_NOT_FOUND');
    current.set(submission.id, {
      submission,
      question,
      availability: {
        owner,
        questionId: question.id,
        retiredAt: availability.retiredAt ?? null,
      },
    });
  }
  for (const row of current.values()) {
    const availability = changes.availability?.find(
      (entry) => entry.owner === owner && entry.questionId === row.question.id,
    );
    if (availability)
      row.availability = {
        owner,
        questionId: row.question.id,
        retiredAt: availability.retiredAt ?? null,
      };
  }
  const entries = [...current.values()].sort((left, right) =>
    left.submission.id.localeCompare(right.submission.id),
  );
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
  const ruleId = 'authored';
  const [latestRule] = await db
    .select({ version: max(rulesetVersions.version) })
    .from(rulesetVersions)
    .where(and(eq(rulesetVersions.owner, owner), eq(rulesetVersions.rulesetId, ruleId)));
  const ruleVersion = (latestRule?.version ?? 0) + 1;
  const latest = await db
    .select({ id: competitions.competitionId, version: max(competitions.version) })
    .from(competitions)
    .where(
      and(
        eq(competitions.owner, owner),
        sql`${competitions.competitionId} in ('authored-casual','authored-band-0','authored-band-1','authored-band-2')`,
      ),
    )
    .groupBy(competitions.competitionId);
  const [instance] = await db
    .select()
    .from(instances)
    .where(eq(instances.id, instanceId));
  if (!instance || instance.owner !== owner) throw new Error('INSTANCE_NOT_FOUND');
  const sets: (typeof questionSets.$inferInsert)[] = [];
  const items: (typeof questionSetItems.$inferInsert)[] = [];
  const competitionRows: (typeof competitions.$inferInsert)[] = [];
  const profiles: (typeof matchmakingSettings.$inferInsert)[] = [];
  for (const band of [0, 1, 2, 3]) {
    const casual = band === 3;
    const id = casual ? 'authored-casual' : `authored-band-${band}`;
    const targets = casual
      ? [`${profile}-casual`]
      : band === 0
        ? [profile, `${profile}-band-0`]
        : [`${profile}-band-${band}`];
    const available = entries
      .filter(
        (entry) =>
          entry.availability.retiredAt === null &&
          entry.question.difficulty !== undefined &&
          (casual ||
            (entry.question.difficulty <= band &&
              (configuration?.config.difficultyWeights?.[band]?.[
                entry.question.difficulty
              ] ?? 1) > 0 &&
              (configuration?.config.categoryWeights?.[entry.question.categoryId ?? ''] ??
                1) > 0)),
      )
      .map((entry) => entry.question);
    const version = (latest.find((row) => row.id === id)?.version ?? 0) + 1;
    sets.push({
      owner,
      setId: id,
      version,
      manifestHash: await contentHash(available),
      selection: {
        authorNames: configuration?.config.showAuthor
          ? Object.fromEntries(
              entries.map((row) => [
                row.question.id,
                row.submission.provenance?.author ?? row.submission.authorName,
              ]),
            )
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
        sets.push({ owner, setId, version, manifestHash: await contentHash(chunk) });
      items.push(
        ...chunk.map((question, index) => ({
          owner,
          setId,
          setVersion: version,
          ordinal: index + 1,
          questionId: question.id,
          questionVersion: 1,
        })),
      );
    }
    competitionRows.push({
      owner,
      competitionId: id,
      version,
      playersPerMatch: casual
        ? (changes.casualConfig ?? instance.casualConfig).players
        : (rankedPlayers ?? old?.players ?? 4),
      rulesetId: ruleId,
      rulesetVersion: ruleVersion,
      setId: id,
      setVersion: version,
    });
    profiles.push(
      ...targets.map((profile) => ({
        owner,
        profile,
        competitionId: id,
        competitionVersion: version,
      })),
    );
  }
  writes.push(
    db.insert(rulesetVersions).values({
      owner,
      rulesetId: ruleId,
      version: ruleVersion,
      rulesHash: await contentHash(config),
      config,
    }),
    rowsD1(questionSets, sets),
  );
  if (items.length) writes.push(rowsD1(questionSetItems, items));
  writes.push(
    rowsD1(competitions, competitionRows),
    rowsD1(matchmakingSettings, profiles, true),
  );
}
