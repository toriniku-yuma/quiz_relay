import { and, eq, gt, sql } from 'drizzle-orm';
import type { ResultsQuery } from '../../shared/results.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, readD1 } from '../db/d1.ts';
import {
  guestSessions,
  matches,
  moderationRequests,
  organizationAccounts,
  resultPlayers,
  userReports,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError, validId } from '../organization/access.ts';
import { organizationDatabase } from '../organization/database.ts';
import { recordQuestionReport } from '../questions/write.ts';
import { privateResultSQL } from '../results/privacy.ts';
import { readResults } from '../results/read.ts';
import type { ResultRecord } from '../results/record.ts';
import { guestLifetime, type participantContext } from './database.ts';

type Identity = Awaited<ReturnType<typeof participantContext>>;
async function requireCurrentActor(
  db: ReturnType<typeof organizationDatabase>['db'],
  identity: Identity,
) {
  const [current] = identity.actor.guest
    ? await db
        .select({ id: guestSessions.actorId })
        .from(guestSessions)
        .where(
          and(
            eq(guestSessions.actorId, identity.actor.id),
            eq(guestSessions.organizationId, identity.instance.organizationId),
            gt(guestSessions.expiresAt, new Date().toISOString()),
          ),
        )
    : await db
        .select({ id: organizationAccounts.actorId })
        .from(organizationAccounts)
        .where(
          and(
            eq(organizationAccounts.actorId, identity.actor.id),
            eq(organizationAccounts.organizationId, identity.instance.organizationId),
            sql`${organizationAccounts.withdrawnAt} is null`,
          ),
        );
  if (!current) throw new OrganizationError('REPORT_NOT_ALLOWED', 403);
}
export async function history(env: Env, identity: Identity, query: ResultsQuery = {}) {
  const { db } = organizationDatabase(env);
  return readD1(db, async () => {
    await requireCurrentActor(db, identity);
    const result = await readResults(db, identity.instance.owner, identity.actor.id, [], {
      ...query,
      ...(identity.actor.guest
        ? {
            finishedAfter: new Date(Date.now() - guestLifetime).toISOString(),
            section: 'history' as const,
          }
        : {}),
    });
    if (identity.actor.guest) {
      result.ranking = [];
      result.history = result.history.filter(
        (match) => Date.now() - Date.parse(match.finishedAt) < guestLifetime,
      );
    }
    return result;
  });
}
export async function report(
  env: Env,
  identity: Identity,
  input: Record<string, unknown>,
) {
  const operationId = validId(input.operationId),
    matchId = validId(input.matchId),
    hash = await contentHash(input),
    { db } = organizationDatabase(env);
  return changeD1(db, async (writes) => {
    await requireCurrentActor(db, identity);
    const [previous] = await db
      .select()
      .from(moderationRequests)
      .where(eq(moderationRequests.id, operationId));
    if (previous) {
      if (previous.operatorId !== identity.actor.id || previous.requestHash !== hash)
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      return { ok: true };
    }
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
          eq(resultPlayers.actorId, identity.actor.id),
        ),
      );
    if (
      !row ||
      (identity.actor.guest &&
        Date.now() - row.payload.result.finishedAt >= guestLifetime)
    )
      throw new OrganizationError('REPORT_NOT_ALLOWED', 403);
    if (input.action === 'question')
      await recordQuestionReport(
        db,
        writes,
        identity.instance.id,
        identity.actor.id,
        input,
        row.payload.completedQuestions?.find(
          (question) => question.id === input.questionId,
        ),
      );
    else if (input.action === 'user') {
      const target = row.payload.players.find((player) => player.id === input.actorId);
      if (
        !target ||
        target.guest ||
        target.id === identity.actor.id ||
        typeof input.reason !== 'string' ||
        !input.reason.trim() ||
        input.reason.length > 1000
      )
        throw new OrganizationError('REPORT_NOT_ALLOWED', 403);
      const [account] = await db
        .select()
        .from(organizationAccounts)
        .where(
          and(
            eq(organizationAccounts.actorId, target.id),
            eq(organizationAccounts.organizationId, identity.instance.organizationId),
          ),
        );
      if (!account) throw new OrganizationError('REPORT_NOT_ALLOWED', 403);
      writes.push(
        db.insert(userReports).values({
          id: operationId,
          organizationId: identity.instance.organizationId,
          instanceId: identity.instance.id,
          actorId: target.id,
          reporterId: identity.actor.id,
          matchId,
          reason: input.reason.trim(),
        }),
      );
    } else throw new OrganizationError('INVALID_REPORT', 400);
    writes.push(
      db.insert(moderationRequests).values({
        id: operationId,
        organizationId: identity.instance.organizationId,
        operatorId: identity.actor.id,
        requestHash: hash,
        details: { action: 'report', instanceId: identity.instance.id },
      }),
    );
    return { ok: true };
  });
}
