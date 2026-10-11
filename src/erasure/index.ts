import { eq, sql } from 'drizzle-orm';
import { changeD1, connectD1, type Database, readD1 } from '../worker/db/d1.ts';
import {
  accountWithdrawals,
  instanceDeletions,
  instanceRooms,
  instances,
} from '../worker/db/schema.ts';
import type { Env } from '../worker/env.ts';
import { applyControlEvent, deliverControlEvent } from '../worker/federation/controls.ts';
import { refreshScheduledFederationMetadata } from '../worker/federation/metadata.ts';
import { syncQuestionImport } from '../worker/federation/question-imports.ts';
import { deliverResult } from '../worker/federation/results.ts';
import { expireHostParticipations } from '../worker/federation/slots.ts';
import { expireFederationNonces } from '../worker/federation/transport.ts';
import { failureCode } from '../worker/http/handlers.ts';
import { OrganizationError } from '../worker/organization/access.ts';
import { updateDifficultyInstance } from '../worker/questions/daily.ts';
import { clerkAuthDeletion } from './clerk.ts';
import { eraseInstance } from './instances.ts';
import type { InventoryEnv } from './inventory.ts';
import { reconcileRoomInventory } from './inventory.ts';
import { eraseAuthentication } from './jobs.ts';
import { eraseResultNames } from './results.ts';
import { expireRecords } from './retention.ts';
import { expireSharedQuestions } from './shared-questions.ts';
import { anonymizeWithdrawal } from './withdrawals.ts';

type ErasureEnv = InventoryEnv &
  Pick<
    Env,
    | 'MATCHMAKER'
    | 'AUTH_PROVIDER'
    | 'CLERK_SECRET_KEY'
    | 'CLERK_PUBLISHABLE_KEY'
    | 'CLERK_JWT_KEY'
    | 'GAME_CONFIG_PROFILE'
    | 'FEDERATION_ORIGIN'
    | 'SIGNING_KID'
    | 'SIGNING_PRIVATE_KEY'
  > & { GAME_D1: D1Database };
export async function expireRoomReviews(db: Database, rooms: Env['GAME_ROOM']) {
  const due = await db
    .select()
    .from(instanceRooms)
    .orderBy(instanceRooms.reviewAttemptedAt, instanceRooms.roomId)
    .limit(5);
  let failed = false;
  for (const room of due)
    try {
      await rooms.get(rooms.idFromString(room.roomId)).expireReview();
    } catch {
      failed = true;
    }
  if (due.length)
    await changeD1(db, async (writes) => {
      writes.push(
        db
          .update(instanceRooms)
          .set({ reviewAttemptedAt: new Date().toISOString() })
          .where(
            sql`${instanceRooms.roomId} in (select value from json_each(${JSON.stringify(due.map((room) => room.roomId))}))`,
          ),
      );
    });
  if (failed) throw new Error('REVIEW_EXPIRY_INCOMPLETE');
}
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
  if (input.task === 'federationNonces') {
    await expireFederationNonces(db);
    return true;
  }
  if (input.task === 'federationSessions') {
    await expireHostParticipations(env as Env);
    return true;
  }
  if (input.task === 'federationResult') {
    if (typeof input.eventId !== 'string') throw new Error('INVALID_OPERATION');
    await deliverResult(env as Env, input.eventId);
    return true;
  }
  if (input.task === 'federationQuestions') {
    if (typeof input.importId !== 'string') throw new Error('INVALID_OPERATION');
    return syncQuestionImport(env as Env, input.importId);
  }
  if (input.task === 'sharedQuestionRetention') {
    await expireSharedQuestions(db);
    return true;
  }
  if (input.task === 'federationControl' || input.task === 'federationControlApply') {
    if (typeof input.eventId !== 'string' || typeof input.peerOrigin !== 'string')
      throw new Error('INVALID_OPERATION');
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
    await eraseResultNames(db);
    return true;
  }
  if (input.task === 'retention') {
    await expireRecords(db);
    return true;
  }
  if (input.task === 'reviews') {
    await expireRoomReviews(db, env.GAME_ROOM);
    return true;
  }
  if (input.task === 'inventory') return reconcileRoomInventory(db, env);
  if (input.task === 'instance')
    return eraseInstance(db, env.GAME_ROOM, operationId(input));
  if (input.task === 'anonymization')
    return anonymizeWithdrawal(db, env, operationId(input));
  if (input.task === 'authentication') {
    const id = operationId(input);
    if (env.AUTH_PROVIDER !== 'clerk' || !env.CLERK_SECRET_KEY)
      throw new Error('AUTH_ERASURE_CONFIGURATION_REQUIRED');
    return eraseAuthentication(db, id, clerkAuthDeletion(env));
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
// No public route and no Cron here. The root scheduler dispatches one task per service invocation.
export default {
  async fetch(request: Request, env: ErasureEnv) {
    if (request.method !== 'POST') return new Response(null, { status: 404 });
    const path = new URL(request.url).pathname;
    if (
      !['/status', '/maintenance', '/inventory', '/withdrawal', '/instance'].includes(
        path,
      )
    )
      return new Response(null, { status: 404 });
    const db = connectD1(env.GAME_D1);
    let taskName = 'invalid';
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
              pendingInstanceDeletion: sql<number>`count(*) filter(where ${instanceDeletions.deletedAt} is null or ${instanceDeletions.inventoryPending})`,
            })
            .from(instanceDeletions);
          const [inventory] = await db
            .select({
              unreconciledInstances: sql<number>`count(*) filter(where not ${instances.roomInventoryComplete})`,
            })
            .from(instances);
          return { ...withdrawals, ...deletions, ...inventory };
        }),
      );
    try {
      const body = await request.text();
      if (body.length > 512) return new Response(null, { status: 413 });
      const input = body ? JSON.parse(body) : {};
      if (!input || typeof input !== 'object' || Array.isArray(input))
        return new Response(null, { status: 400 });
      const task =
        path === '/withdrawal'
          ? 'authentication'
          : path === '/instance'
            ? 'instance'
            : path === '/inventory'
              ? 'inventory'
              : input.task;
      if (
        typeof task === 'string' &&
        [
          'federationNonces',
          'federationSessions',
          'federationResult',
          'federationQuestions',
          'sharedQuestionRetention',
          'federationControl',
          'federationControlApply',
          'federationMetadata',
          'results',
          'retention',
          'reviews',
          'inventory',
          'instance',
          'anonymization',
          'authentication',
          'difficulty',
        ].includes(task)
      )
        taskName = task;
      const ready = await maintenance(db, env, { ...input, task });
      return Response.json(
        typeof ready === 'object' ? { ready: true, ...ready } : { ready },
        { status: ready ? 200 : 503 },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'maintenance_failed',
          task: taskName,
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
