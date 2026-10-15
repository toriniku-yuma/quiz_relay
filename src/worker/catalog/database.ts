import { and, asc, eq, exists, inArray, or, sql } from 'drizzle-orm';
import { connectD1, readD1 } from '../db/d1.ts';
import {
  questionAvailability as a,
  competitions as c,
  questionSetItems as i,
  matches,
  questionVersions as q,
  rulesetVersions as r,
  resultPlayers,
  questionSets as s,
  matchmakingSettings as settings,
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

export type ActiveProfile = { owner: string; profile: string };

// One statement keeps the definition, ordered questions and availability in one DB snapshot.
export async function loadMatchDefinition(
  env: Env,
  active: ActiveProfile,
  actorId?: string,
): Promise<MatchDefinition> {
  const { owner, profile } = active;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error('INVALID_CONFIG_PROFILE');
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
          exists(
            db
              .select()
              .from(settings)
              .where(
                and(
                  eq(settings.owner, c.owner),
                  eq(settings.profile, profile),
                  eq(settings.competitionId, c.competitionId),
                  eq(settings.competitionVersion, c.version),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(i.setId), asc(i.ordinal));
    if (!rows.length) throw new Error('RANKED_NOT_CONFIGURED');
    if (actorId && /^authored-band-[0-2]$/.test(rows[0].competition.competitionId)) {
      const [rating] = await db
        .select({
          value:
            sql<number>`1000 + coalesce(sum(${resultPlayers.ratingDelta}), 0)`.mapWith(
              Number,
            ),
        })
        .from(resultPlayers)
        .innerJoin(matches, eq(matches.matchId, resultPlayers.matchId))
        .where(
          and(
            eq(matches.owner, owner),
            eq(resultPlayers.actorId, actorId),
            sql`json_extract(${matches.payload}, '$.kind') = 'ranked'`,
          ),
        );
      const boundaries = rows[0].questionSet.selection?.boundaries ?? [1200, 1600];
      const band =
        rating.value < boundaries[0] ? 0 : rating.value < boundaries[1] ? 1 : 2;
      if (band > 0)
        return loadMatchDefinition(env, { owner, profile: `${profile}-band-${band}` });
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

// The room already holds the validated questions; only the immutable version must still exist.
// Question availability is not checked, so a stop applies from the next waiting room.
export async function loadFixedVersion(env: Env, reference: VersionRef) {
  const ref = validateRef(reference);
  if (!env.GAME_D1) throw new Error('GAME_DATABASE_NOT_CONFIGURED');
  const db = connectD1(env.GAME_D1);
  return readD1(db, async () => {
    const [row] = await db
      .select({ playersPerMatch: c.playersPerMatch, rulesHash: r.rulesHash })
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
      .where(
        and(
          eq(c.owner, ref.owner),
          eq(c.competitionId, ref.id),
          eq(c.version, ref.version),
        ),
      );
    if (!row) throw new Error('DEFINITION_NOT_FOUND');
    return row;
  });
}
