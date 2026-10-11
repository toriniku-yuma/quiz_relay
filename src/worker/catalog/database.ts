import { and, asc, eq, exists, inArray, or, sql } from 'drizzle-orm';
import { connectD1, readD1 } from '../db/d1.ts';
import {
  questionAvailability as a,
  matchmakingSettings as active,
  competitions as c,
  questionSetItems as i,
  matchResults,
  questionVersions as q,
  rulesetVersions as r,
  resultPlayers,
  questionSets as s,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { sharedQuestionAvailableSQL } from '../federation/question-access.ts';
import { decodeSelection, privateSelectionSQL } from '../results/privacy.ts';
import {
  type MatchDefinition,
  type VersionRef,
  validateDefinition,
  validateRef,
} from './definition.ts';
import { contentHash } from './hash.ts';

// One statement keeps the definition, ordered questions and availability in one DB snapshot.
export async function loadMatchDefinition(
  env: Env,
  reference?: VersionRef,
  actorId?: string,
): Promise<MatchDefinition> {
  const ref = reference ? validateRef(reference) : null;
  const owner = ref?.owner ?? env.GAME_OWNER;
  const profile = env.GAME_CONFIG_PROFILE;
  if (!ref && (!profile || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile)))
    throw new Error('INVALID_CONFIG_PROFILE');
  if (!env.GAME_D1) throw new Error('GAME_DATABASE_NOT_CONFIGURED');
  const db = connectD1(env.GAME_D1);
  return readD1(db, async () => {
    const rows = await db
      .select({
        competition: c,
        ruleset: r,
        questionSet: s,
        privateSelection: privateSelectionSQL(s.owner, s.selection).mapWith(
          decodeSelection,
        ),
        question: q.payload,
        availability: a,
        sharedAvailable: sharedQuestionAvailableSQL(q.owner, q.questionId),
      })
      .from(c)
      .innerJoin(
        r,
        and(
          eq(r.owner, c.owner),
          eq(r.rulesetId, c.rulesetId),
          eq(r.version, c.rulesetVersion),
        ),
      )
      .innerJoin(
        s,
        and(eq(s.owner, c.owner), eq(s.setId, c.setId), eq(s.version, c.setVersion)),
      )
      .leftJoin(
        i,
        and(
          eq(i.owner, s.owner),
          or(
            eq(i.setId, s.setId),
            and(
              inArray(s.setId, [
                'authored-band-0',
                'authored-band-1',
                'authored-band-2',
                'authored-casual',
              ]),
              sql`${i.setId} LIKE ${s.setId} || '-chunk-%'`,
            ),
          ),
          eq(i.setVersion, s.version),
        ),
      )
      .leftJoin(
        q,
        and(
          eq(q.owner, i.owner),
          eq(q.questionId, i.questionId),
          eq(q.version, i.questionVersion),
        ),
      )
      .leftJoin(a, and(eq(a.owner, q.owner), eq(a.questionId, q.questionId)))
      .where(
        and(
          eq(c.owner, owner),
          ref
            ? and(eq(c.competitionId, ref.id), eq(c.version, ref.version))
            : exists(
                db
                  .select()
                  .from(active)
                  .where(
                    and(
                      eq(active.owner, c.owner),
                      eq(active.profile, profile ?? ''),
                      eq(active.competitionId, c.competitionId),
                      eq(active.competitionVersion, c.version),
                    ),
                  ),
              ),
        ),
      )
      .orderBy(asc(i.setId), asc(i.ordinal));
    if (!rows.length)
      throw new Error(ref ? 'DEFINITION_NOT_FOUND' : 'RANKED_NOT_CONFIGURED');
    if (
      !ref &&
      actorId &&
      /^authored-band-[0-2]$/.test(rows[0].competition.competitionId)
    ) {
      const [rating] = await db
        .select({
          value:
            sql<number>`1000 + coalesce(sum(${resultPlayers.ratingDelta}), 0)`.mapWith(
              Number,
            ),
        })
        .from(resultPlayers)
        .innerJoin(matchResults, eq(matchResults.resultId, resultPlayers.resultId))
        .where(
          and(
            eq(matchResults.owner, owner),
            eq(resultPlayers.actorId, actorId),
            sql`json_extract(${matchResults.payload}, '$.kind') = 'ranked'`,
          ),
        );
      const boundaries = rows[0].questionSet.selection?.boundaries ?? [1200, 1600];
      const band =
        rating.value < boundaries[0] ? 0 : rating.value < boundaries[1] ? 1 : 2;
      if (band > 0)
        return loadMatchDefinition({
          ...env,
          GAME_CONFIG_PROFILE: `${profile}-band-${band}`,
        });
    }
    const availableRows = rows.filter((row) => row.sharedAvailable === 1);
    if (
      availableRows.every(
        (row) =>
          !row.question || (!!row.availability && row.availability.retiredAt !== null),
      )
    )
      throw Object.assign(new Error('NO_RANKED_QUESTIONS'), {
        band: rows[0].questionSet.selection?.band,
      });
    if (
      availableRows.some(
        (row) =>
          !row.question || !row.availability || row.availability.retiredAt !== null,
      )
    )
      throw new Error('QUESTION_UNAVAILABLE');
    const { competition, ruleset, questionSet } = rows[0];
    return await validateDefinition({
      ...(competition.competitionId === 'authored-casual'
        ? { kind: 'casual' as const }
        : {}),
      ...(rows[0].privateSelection ? { selection: rows[0].privateSelection } : {}),
      competition: {
        owner: competition.owner,
        id: competition.competitionId,
        version: competition.version,
      },
      ruleset: { owner: ruleset.owner, id: ruleset.rulesetId, version: ruleset.version },
      questionSet: {
        owner: questionSet.owner,
        id: questionSet.setId,
        version: questionSet.version,
      },
      playersPerMatch: competition.playersPerMatch,
      rulesHash: ruleset.rulesHash,
      manifestHash:
        availableRows.length === rows.length
          ? questionSet.manifestHash
          : await contentHash(availableRows.map((row) => row.question)),
      rules: ruleset.config,
      questions: availableRows.map((row) => row.question),
    });
  });
}
