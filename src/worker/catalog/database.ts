import { and, asc, eq, exists, or, sql } from 'drizzle-orm';
import { connectDatabase } from '../db/connection.ts';
import {
  questionAvailability as a,
  matchmakingSettings as active,
  competitions as c,
  questionSetItems as i,
  questionVersions as q,
  rulesetVersions as r,
  questionSets as s,
} from '../db/schema.ts';
import type { Env } from '../env';
import { rankingBand } from '../questions/ranking.ts';
import { type VersionRef, validateDefinition, validateRef } from './definition.ts';

// One statement keeps the definition, ordered questions and availability in one DB snapshot.
export async function loadMatchDefinition(
  env: Env,
  reference?: VersionRef,
  actorId?: string,
) {
  const ref = reference ? validateRef(reference) : null;
  const owner = ref?.owner ?? env.GAME_OWNER;
  const profile = env.GAME_CONFIG_PROFILE;
  if (!ref && (!profile || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile)))
    throw new Error('INVALID_CONFIG_PROFILE');
  const binding = env.GAME_HYPERDRIVE;
  const url = binding?.connectionString ?? env.GAME_DATABASE_URL;
  if (!url) throw new Error('GAME_DATABASE_NOT_CONFIGURED');
  const { db, close } = connectDatabase(url, env.DATABASE_CA_CERT, !!binding);
  try {
    const rows = await db
      .select({
        competition: c,
        ruleset: r,
        questionSet: s,
        privateSelection: sql<
          typeof s.$inferSelect.selection
        >`quiz_game.private_selection(${s.owner},${s.selection})`,
        question: q.payload,
        availability: a,
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
              sql`${s.setId} ~ '^authored-(band-[0-2]|casual)$'`,
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
      const band = await rankingBand(
        env,
        owner,
        actorId,
        rows[0].questionSet.selection?.boundaries,
      );
      if (band > 0)
        return loadMatchDefinition({
          ...env,
          GAME_CONFIG_PROFILE: `${profile}-band-${band}`,
        });
    }
    if (
      rows.every(
        (row) =>
          !row.question || (!!row.availability && row.availability.retiredAt !== null),
      )
    )
      throw Object.assign(new Error('NO_RANKED_QUESTIONS'), {
        band: rows[0].questionSet.selection?.band,
      });
    if (
      rows.some(
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
      manifestHash: questionSet.manifestHash,
      rules: ruleset.config,
      questions: rows.map((row) => row.question),
    });
  } finally {
    await close();
  }
}
