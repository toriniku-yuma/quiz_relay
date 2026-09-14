import { and, asc, eq, max, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  questionAvailability as a,
  matchmakingSettings as active,
  competitions as c,
  questionSetItems as i,
  questionVersions as q,
  rulesetVersions as r,
  questionSets as s,
} from '../db/schema.ts';
import { validateMatchConfig } from './config.ts';
import { validateDefinition } from './definition.ts';
import { contentHash } from './hash.ts';

export async function publishMatchConfig(
  db: PostgresJsDatabase,
  input: unknown,
  profile: string,
) {
  const config = validateMatchConfig(input);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error('INVALID_CONFIG_PROFILE');
  const hash = await contentHash(config.rules);
  return db.transaction(async (tx) => {
    // PostgreSQL-specific transaction lock; values remain bound parameters.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${config.owner}, 0))`,
    );
    const rows = await tx
      .select({ manifestHash: s.manifestHash, question: q.payload, availability: a })
      .from(s)
      .innerJoin(
        i,
        and(eq(i.owner, s.owner), eq(i.setId, s.setId), eq(i.setVersion, s.version)),
      )
      .innerJoin(
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
          eq(s.owner, config.owner),
          eq(s.setId, config.questionSet.id),
          eq(s.version, config.questionSet.version),
        ),
      )
      .orderBy(asc(i.ordinal));
    if (!rows.length) throw new Error('QUESTION_SET_NOT_FOUND');
    if (rows.some((row) => !row.availability || row.availability.retiredAt !== null))
      throw new Error('QUESTION_UNAVAILABLE');
    await validateDefinition({
      competition: { owner: config.owner, id: config.competitionId, version: 1 },
      ruleset: { owner: config.owner, id: config.rulesetId, version: 1 },
      questionSet: { owner: config.owner, ...config.questionSet },
      playersPerMatch: config.playersPerMatch,
      rules: config.rules,
      rulesHash: hash,
      manifestHash: rows[0].manifestHash,
      questions: rows.map((row) => row.question),
    });
    const ruleScope = and(eq(r.owner, config.owner), eq(r.rulesetId, config.rulesetId));
    const [existingRule] = await tx
      .select({ version: r.version })
      .from(r)
      .where(and(ruleScope, eq(r.rulesHash, hash)))
      .orderBy(asc(r.version))
      .limit(1);
    let ruleVersion = existingRule?.version;
    if (!ruleVersion) {
      const [latest] = await tx
        .select({ version: max(r.version) })
        .from(r)
        .where(ruleScope);
      ruleVersion = (latest.version ?? 0) + 1;
      await tx.insert(r).values({
        owner: config.owner,
        rulesetId: config.rulesetId,
        version: ruleVersion,
        rulesHash: hash,
        config: config.rules,
      });
    }
    const competitionScope = and(
      eq(c.owner, config.owner),
      eq(c.competitionId, config.competitionId),
    );
    const [existingCompetition] = await tx
      .select({ version: c.version })
      .from(c)
      .where(
        and(
          competitionScope,
          eq(c.playersPerMatch, config.playersPerMatch),
          eq(c.rulesetId, config.rulesetId),
          eq(c.rulesetVersion, ruleVersion),
          eq(c.setId, config.questionSet.id),
          eq(c.setVersion, config.questionSet.version),
        ),
      )
      .orderBy(asc(c.version))
      .limit(1);
    let version = existingCompetition?.version;
    if (!version) {
      const [latest] = await tx
        .select({ version: max(c.version) })
        .from(c)
        .where(competitionScope);
      version = (latest.version ?? 0) + 1;
      await tx.insert(c).values({
        owner: config.owner,
        competitionId: config.competitionId,
        version,
        playersPerMatch: config.playersPerMatch,
        rulesetId: config.rulesetId,
        rulesetVersion: ruleVersion,
        setId: config.questionSet.id,
        setVersion: config.questionSet.version,
      });
    }
    await tx
      .insert(active)
      .values({
        owner: config.owner,
        profile,
        competitionId: config.competitionId,
        competitionVersion: version,
      })
      .onConflictDoUpdate({
        target: [active.owner, active.profile],
        set: { competitionId: config.competitionId, competitionVersion: version },
      });
    return {
      profile,
      competitionId: config.competitionId,
      version,
      playersPerMatch: config.playersPerMatch,
    };
  });
}
