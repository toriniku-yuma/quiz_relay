import { and, eq, sql } from 'drizzle-orm';
import { connectDatabase } from '../db/connection.ts';
import { matchResults, resultPlayers } from '../db/schema.ts';
import type { Env } from '../env';
import { OrganizationError } from '../organization/access.ts';
import { organizationDatabase, resolveInstance } from '../organization/database.ts';

export async function verifiedReportedQuestion(
  env: Env,
  subject: string,
  instanceId: string,
  resultId: unknown,
  questionId: unknown,
) {
  if (
    typeof resultId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(resultId) ||
    typeof questionId !== 'string'
  )
    throw new OrganizationError('INVALID_REPORT', 400);
  const organization = organizationDatabase(env);
  let identity: Awaited<ReturnType<typeof resolveInstance>>;
  try {
    identity = await resolveInstance(organization.db, subject, instanceId, true);
  } finally {
    await organization.close();
  }
  const binding = env.GAME_HYPERDRIVE;
  const address = binding?.connectionString ?? env.GAME_DATABASE_URL;
  if (!address) throw new OrganizationError('RESULTS_UNAVAILABLE', 503);
  const { db, close } = connectDatabase(address, env.DATABASE_CA_CERT, !!binding);
  try {
    const [row] = await db
      .select({
        payload: sql<
          typeof matchResults.$inferSelect.payload
        >`quiz_game.private_result(${matchResults.payload})`,
      })
      .from(matchResults)
      .innerJoin(resultPlayers, eq(resultPlayers.resultId, matchResults.resultId))
      .where(
        and(
          eq(matchResults.resultId, resultId),
          eq(matchResults.owner, identity.instance.owner),
          eq(resultPlayers.actorId, identity.account.actorId),
        ),
      );
    const question = row?.payload.completedQuestions?.find(
      (candidateQuestion) => candidateQuestion.id === questionId,
    );
    if (!question) throw new OrganizationError('QUESTION_NOT_FOUND', 404);
    return question;
  } finally {
    await close();
  }
}
