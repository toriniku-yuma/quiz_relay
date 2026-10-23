import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { connectD1, type Database, readD1 } from '../worker/db/d1.ts';
import {
  accountWithdrawals,
  federationControlDeliveries,
  instanceDeletions,
  instances,
} from '../worker/db/schema.ts';
import type { Env } from '../worker/env.ts';
import { applyControlEvent, deliverControlEvent } from '../worker/federation/controls.ts';
import { refreshScheduledFederationMetadata } from '../worker/federation/metadata.ts';
import { syncQuestionImport } from '../worker/federation/question-imports.ts';
import { refreshQuestionSource } from '../worker/federation/question-sources.ts';
import { deliverResult } from '../worker/federation/results.ts';
import {
  expireFederationSessions,
  expireHostParticipations,
} from '../worker/federation/slots.ts';
import { expireFederationNonces } from '../worker/federation/transport.ts';
import { failureCode, failureDetails } from '../worker/http/diagnostics.ts';
import { OrganizationError } from '../worker/organization/access.ts';
import { updateDifficultyInstance } from '../worker/questions/daily.ts';
import { clerkAuthDeletion } from './clerk.ts';
import { eraseInstance } from './instances.ts';
import { eraseAuthentication } from './jobs.ts';
import { eraseResultNames } from './results.ts';
import { expireRecords } from './retention.ts';
import { expireSharedQuestions } from './shared-questions.ts';
import { anonymizeWithdrawal } from './withdrawals.ts';

type ErasureEnv = Pick<
  Env,
  | 'MATCHMAKER'
  | 'GAME_ROOM'
  | 'ACCOUNT_ERASURE'
  | 'CLERK_SECRET_KEY'
  | 'GAME_CONFIG_PROFILE'
  | 'FEDERATION_LIMITER'
  | 'FEDERATION_ORIGIN'
  | 'SIGNING_KID'
  | 'SIGNING_PRIVATE_KEY'
> & { GAME_D1: D1Database };
function operationId(input: Record<string, unknown>) {
  if (
    typeof input.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.operationId,
    )
  )
    throw new Error('INVALID_OPERATION');
  return input.operationId;
}
async function maintenance(
  db: Database,
  env: ErasureEnv,
  input: Record<string, unknown>,
) {
  if (input.task === 'federationControls') {
    if (typeof input.eventId !== 'string') throw new Error('INVALID_OPERATION');
    const [job] = await db
      .select()
      .from(federationControlDeliveries)
      .where(
        and(
          eq(federationControlDeliveries.eventId, input.eventId),
          isNull(federationControlDeliveries.appliedAt),
          eq(federationControlDeliveries.quarantined, false),
          lte(federationControlDeliveries.nextAttemptAt, Date.now()),
          lte(federationControlDeliveries.leaseUntil, Date.now()),
        ),
      )
      .limit(1);
    if (!job) return true;
    await deliverControlEvent(env as Env, job.peerOrigin, job.eventId);
    return false;
  }
  if (input.task === 'federationNonces') {
    await expireFederationNonces(db);
    return true;
  }
  if (input.task === 'federationReservations')
    return expireHostParticipations(env as Env);
  if (input.task === 'federationSessions') {
    await expireFederationSessions(env as Env);
    return true;
  }
  if (input.task === 'federationResult') {
    if (typeof input.eventId !== 'string') throw new Error('INVALID_OPERATION');
    await deliverResult(env as Env, input.eventId);
    return true;
  }
  if (input.task === 'federationQuestionSource') {
    if (
      typeof input.instanceId !== 'string' ||
      typeof input.peerOrigin !== 'string' ||
      typeof input.sourceInstanceId !== 'string'
    )
      throw new Error('INVALID_OPERATION');
    await refreshQuestionSource(env as Env, {
      instanceId: input.instanceId,
      peerOrigin: input.peerOrigin,
      sourceInstanceId: input.sourceInstanceId,
    });
    return true;
  }
  if (input.task === 'federationQuestions') {
    if (typeof input.importId !== 'string') throw new Error('INVALID_OPERATION');
    const result = await syncQuestionImport(env as Env, input.importId);
    return !result.pending;
  }
  if (input.task === 'sharedQuestionRetention') {
    await expireSharedQuestions(db);
    return true;
  }
  if (input.task === 'federationControl' || input.task === 'federationControlApply') {
    if (typeof input.eventId !== 'string' || typeof input.peerOrigin !== 'string')
      throw new Error('INVALID_OPERATION');
    if (input.task === 'federationControlApply' && (await eraseResultNames(db)) > 0)
      return false;
    const run =
      input.task === 'federationControl' ? deliverControlEvent : applyControlEvent;
    await run(env as Env, input.peerOrigin, input.eventId);
    return true;
  }
  if (input.task === 'federationMetadata') {
    if (typeof input.instanceId !== 'string' || typeof input.peerOrigin !== 'string')
      throw new Error('INVALID_OPERATION');
    await refreshScheduledFederationMetadata(
      env as Env,
      input.instanceId,
      input.peerOrigin,
    );
    return true;
  }
  if (input.task === 'results') {
    return (await eraseResultNames(db)) === 0;
  }
  if (input.task === 'retention') {
    await expireRecords(db);
    return true;
  }
  if (input.task === 'instance') return eraseInstance(db, operationId(input));
  if (input.task === 'anonymization') return anonymizeWithdrawal(db, operationId(input));
  if (input.task === 'authentication') {
    const id = operationId(input);
    if (!env.CLERK_SECRET_KEY) throw new Error('AUTH_ERASURE_CONFIGURATION_REQUIRED');
    return eraseAuthentication(db, id, clerkAuthDeletion(env.CLERK_SECRET_KEY));
  }
  if (input.task === 'difficulty') {
    if (typeof input.instanceId !== 'string') throw new Error('INVALID_OPERATION');
    const [scope] = await db
      .select()
      .from(instances)
      .where(eq(instances.id, input.instanceId));
    if (!scope) return true;
    await updateDifficultyInstance(db, env.GAME_CONFIG_PROFILE, {
      organizationId: scope.organizationId,
      instanceId: scope.id,
      owner: scope.owner,
      now: Date.now(),
    });
    return true;
  }
  throw new Error('INVALID_OPERATION');
}
// Private service. Each invocation runs one batch; a chain is limited to 32 batches.
export default {
  async fetch(request: Request, env: ErasureEnv) {
    if (request.method !== 'POST') return new Response(null, { status: 404 });
    const path = new URL(request.url).pathname;
    if (!['/status', '/maintenance', '/withdrawal', '/instance'].includes(path))
      return new Response(null, { status: 404 });
    const db = connectD1(env.GAME_D1);
    let taskName = 'invalid';
    let instanceId: string | undefined;
    if (path === '/status')
      return Response.json(
        await readD1(db, async () => {
          const [withdrawals] = await db
            .select({
              pendingAuthentication: sql<number>`count(*) filter(where ${accountWithdrawals.authDeletedAt} is null)`,
              pendingAnonymization: sql<number>`count(*) filter(where ${accountWithdrawals.erasedAt} is null)`,
              overdueWithdrawals: sql<number>`count(*) filter(where ${accountWithdrawals.erasedAt} is null and ${accountWithdrawals.requestedAt}<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'))`,
              oldestWithdrawalRequestedAt: sql<
                string | null
              >`min(${accountWithdrawals.requestedAt}) filter(where ${accountWithdrawals.erasedAt} is null)`,
            })
            .from(accountWithdrawals);
          const [deletions] = await db
            .select({
              pendingInstanceDeletion: sql<number>`count(*) filter(where ${instanceDeletions.deletedAt} is null)`,
            })
            .from(instanceDeletions);
          return { ...withdrawals, ...deletions };
        }),
      );
    try {
      const body = await request.text();
      if (body.length > 512) return new Response(null, { status: 413 });
      const input = body ? JSON.parse(body) : {};
      if (!input || typeof input !== 'object' || Array.isArray(input))
        return new Response(null, { status: 400 });
      if (
        typeof input.instanceId === 'string' &&
        /^[a-f0-9-]{36}$/.test(input.instanceId)
      )
        instanceId = input.instanceId;
      const task =
        path === '/withdrawal'
          ? 'authentication'
          : path === '/instance'
            ? 'instance'
            : input.task;
      if (
        typeof task === 'string' &&
        [
          'federationControls',
          'federationReservations',
          'federationNonces',
          'federationSessions',
          'federationResult',
          'federationQuestions',
          'federationQuestionSource',
          'sharedQuestionRetention',
          'federationControl',
          'federationControlApply',
          'federationMetadata',
          'results',
          'retention',
          'instance',
          'anonymization',
          'authentication',
          'difficulty',
        ].includes(task)
      )
        taskName = task;
      const depth = input.depth === undefined ? 0 : input.depth;
      if (!Number.isInteger(depth) || depth < 0 || depth >= 32)
        throw new Error('INVALID_OPERATION');
      let ready = await maintenance(db, env, { ...input, task });
      if ((path === '/withdrawal' || path === '/instance') && env.ACCOUNT_ERASURE) {
        const delivery = await env.ACCOUNT_ERASURE.fetch(
          'https://account-erasure.internal/maintenance',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              task: 'federationControls',
              eventId: operationId(input),
              depth: depth + 1,
            }),
          },
        );
        await delivery.arrayBuffer();
      }
      let nextTask = task;
      if (task === 'authentication' && ready) {
        ready = await anonymizeWithdrawal(db, operationId(input));
        nextTask = 'anonymization';
      }
      if (!ready && nextTask !== 'authentication' && depth < 31) {
        if (!env.ACCOUNT_ERASURE) throw new Error('MAINTENANCE_CONFIGURATION_REQUIRED');
        return await env.ACCOUNT_ERASURE.fetch(
          'https://account-erasure.internal/maintenance',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...input, task: nextTask, depth: depth + 1 }),
          },
        );
      }
      return Response.json({ ready }, { status: ready ? 200 : 503 });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'maintenance_failed',
          task: taskName,
          instanceId,
          ...failureDetails(error),
          code: error instanceof OrganizationError ? error.code : failureCode(error),
        }),
      );
      if (error instanceof OrganizationError)
        return Response.json({ code: error.code }, { status: error.status });
      if (error instanceof Error && error.message === 'RESULT_OR_MATCH_PENDING')
        return Response.json({ code: error.message }, { status: 409 });
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === 'INVALID_OPERATION')
      )
        return Response.json({ code: 'INVALID_OPERATION' }, { status: 400 });
      return Response.json({ code: 'MAINTENANCE_FAILED' }, { status: 503 });
    }
  },
};
