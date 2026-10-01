import { and, eq, sql } from 'drizzle-orm';
import { contentHash } from '../catalog/hash.ts';
import { connectDatabase } from '../db/connection.ts';
import {
  matchResults,
  moderationRequests,
  organizationAccounts,
  resultPlayers,
  userReports,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError, validId } from '../organization/access.ts';
import { organizationDatabase } from '../organization/database.ts';
import { recordQuestionReport } from '../questions/database.ts';
import { readResults } from '../results/read.ts';
import { guestLifetime, type participantContext } from './database.ts';

type Identity = Awaited<ReturnType<typeof participantContext>>;
function reader(env: Env) {
  const binding = env.GAME_HYPERDRIVE,
    address = binding?.connectionString ?? env.GAME_DATABASE_URL;
  if (!address) throw new OrganizationError('RESULTS_UNAVAILABLE', 503);
  return connectDatabase(address, env.DATABASE_CA_CERT, !!binding);
}
export async function history(env: Env, identity: Identity) {
  const { db, close } = reader(env);
  try {
    const result = await readResults(db, identity.instance.owner, identity.actor.id);
    if (identity.actor.guest) {
      result.ranking = [];
      result.history = result.history.filter(
        (r) => Date.now() - Date.parse(r.finishedAt) < guestLifetime,
      );
    }
    return result;
  } finally {
    await close();
  }
}
export async function report(
  env: Env,
  identity: Identity,
  input: Record<string, unknown>,
) {
  const operationId = validId(input.operationId),
    resultId = validId(input.resultId),
    hash = await contentHash(input);
  const { db, close } = reader(env);
  let evidence: typeof matchResults.$inferSelect.payload;
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
          eq(resultPlayers.actorId, identity.actor.id),
        ),
      );
    if (
      !row ||
      (identity.actor.guest &&
        Date.now() - row.payload.result.finishedAt >= guestLifetime)
    )
      throw new OrganizationError('REPORT_NOT_ALLOWED', 403);
    evidence = row.payload;
  } finally {
    await close();
  }
  const organization = organizationDatabase(env);
  try {
    return await organization.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('quiz.organization_id',${identity.instance.organizationId},true)`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${identity.instance.id}`},0))`,
      );
      const [previous] = await tx
        .select()
        .from(moderationRequests)
        .where(eq(moderationRequests.id, operationId));
      if (previous) {
        if (previous.operatorId !== identity.actor.id || previous.requestHash !== hash)
          throw new OrganizationError('OPERATION_CONFLICT', 409);
        return { ok: true };
      }
      if (input.action === 'question') {
        await recordQuestionReport(
          tx,
          identity.instance.id,
          identity.actor.id,
          input,
          evidence.completedQuestions?.find((q) => q.id === input.questionId),
        );
      } else if (input.action === 'user') {
        const target = evidence.players.find((p) => p.id === input.actorId);
        if (
          !target ||
          target.guest ||
          target.id === identity.actor.id ||
          typeof input.reason !== 'string' ||
          !input.reason.trim() ||
          input.reason.length > 1000
        )
          throw new OrganizationError('REPORT_NOT_ALLOWED', 403);
        const [account] = await tx
          .select()
          .from(organizationAccounts)
          .where(
            and(
              eq(organizationAccounts.actorId, target.id),
              eq(organizationAccounts.organizationId, identity.instance.organizationId),
            ),
          );
        if (!account) throw new OrganizationError('REPORT_NOT_ALLOWED', 403);
        await tx.insert(userReports).values({
          id: operationId,
          organizationId: identity.instance.organizationId,
          instanceId: identity.instance.id,
          actorId: target.id,
          reporterId: identity.actor.id,
          resultId,
          reason: input.reason.trim(),
        });
      } else throw new OrganizationError('INVALID_REPORT', 400);
      await tx.insert(moderationRequests).values({
        id: operationId,
        organizationId: identity.instance.organizationId,
        operatorId: identity.actor.id,
        requestHash: hash,
        details: { action: 'report', instanceId: identity.instance.id },
      });
      return { ok: true };
    });
  } finally {
    await organization.close();
  }
}
