import { and, eq } from 'drizzle-orm';
import { readD1 } from '../db/d1.ts';
import { matches, resultPlayers } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError } from '../organization/access.ts';
import { organizationDatabase, resolveInstance } from '../organization/database.ts';
import { privateResultSQL } from '../results/privacy.ts';
import type { ResultRecord } from '../results/record.ts';

export async function verifiedReportedQuestion(
  env: Env,
  subject: string,
  instanceId: string,
  matchId: unknown,
  questionId: unknown,
) {
  if (
    typeof matchId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(matchId) ||
    typeof questionId !== 'string'
  )
    throw new OrganizationError('INVALID_REPORT', 400);
  const { db } = organizationDatabase(env);
  return readD1(db, async () => {
    const identity = await resolveInstance(db, subject, instanceId, true);
    const [row] = await db
      .select({
        payload: privateResultSQL(matches.payload).mapWith(
          (value) => JSON.parse(value) as ResultRecord,
        ),
      })
      .from(matches)
      .innerJoin(resultPlayers, eq(resultPlayers.matchId, matches.matchId))
      .where(
        and(
          eq(matches.matchId, matchId),
          eq(matches.owner, identity.instance.owner),
          eq(resultPlayers.actorId, identity.account.actorId),
        ),
      );
    const question = row?.payload.completedQuestions?.find(
      (question) => question.id === questionId,
    );
    if (!question) throw new OrganizationError('QUESTION_NOT_FOUND', 404);
    return question;
  });
}
