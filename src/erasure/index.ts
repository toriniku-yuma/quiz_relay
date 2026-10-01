import { eq, isNull, lte, sql } from 'drizzle-orm';
import { connectDatabase } from '../worker/db/connection.ts';
import {
  accountWithdrawals,
  guestSessions,
  instanceDeletions,
  instanceRooms,
  instances,
} from '../worker/db/schema.ts';
import type { Env } from '../worker/env';
import { eraseInstance, retryInstanceDeletions } from './instances.ts';
import { type InventoryEnv, reconcileRoomInventory } from './inventory.ts';
import { authDeletion, eraseAuthentication, retryAuthentication } from './jobs.ts';
import { erasureBatch } from './limits.ts';
import { eraseResultNames } from './results.ts';
import { anonymizeWithdrawal } from './withdrawals.ts';

export async function expireRoomReviews(
  db: Pick<ReturnType<typeof connectDatabase>['db'], 'select' | 'update'>,
  rooms: Env['GAME_ROOM'],
) {
  const due = await db
    .select()
    .from(instanceRooms)
    .orderBy(instanceRooms.reviewAttemptedAt, instanceRooms.roomId)
    .limit(erasureBatch.rooms);
  let failed = false;
  for (const room of due) {
    try {
      await rooms.get(rooms.idFromString(room.roomId)).expireReview();
    } catch {
      failed = true;
    }
    // Rotate failed rooms as well so one outage cannot starve the rest of the inventory.
    await db
      .update(instanceRooms)
      .set({ reviewAttemptedAt: new Date().toISOString() })
      .where(eq(instanceRooms.roomId, room.roomId));
  }
  if (failed) throw new Error('REVIEW_EXPIRY_INCOMPLETE');
}

// Deploy separately with workers_dev disabled and no public route. Only service bindings call fetch.
type ErasureEnv = InventoryEnv & {
  GAME_ROOM: Env['GAME_ROOM'];
  MATCHMAKER: Env['MATCHMAKER'];
  ERASURE_DATABASE_URL: string;
  DATABASE_CA_CERT?: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};
async function run(env: ErasureEnv, id?: string, instance = false, inventory = false) {
  const { db, close } = connectDatabase(
    env.ERASURE_DATABASE_URL,
    env.DATABASE_CA_CERT,
    false,
  );
  try {
    if (inventory) {
      return await reconcileRoomInventory(db, env);
    }
    const key = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new Error('AUTH_ERASURE_CONFIGURATION_REQUIRED');
    const remove = authDeletion(env.SUPABASE_URL, key);
    if (id) {
      if (instance) return await eraseInstance(db, env.GAME_ROOM, id);
      const ready = await eraseAuthentication(db, id, remove);
      await anonymizeWithdrawal(db, env, id);
      return ready;
    }
    const results = await Promise.allSettled([
      (async () => {
        // Completion depends on the latest Auth result, so retry before anonymizing.
        let failed = false;
        try {
          await retryAuthentication(db, remove);
        } catch {
          failed = true;
        }
        const jobs = await db
          .select({ id: accountWithdrawals.id })
          .from(accountWithdrawals)
          .where(isNull(accountWithdrawals.erasedAt))
          .orderBy(accountWithdrawals.lastAttemptAt, accountWithdrawals.requestedAt)
          .limit(erasureBatch.jobs);
        for (const job of jobs)
          try {
            await anonymizeWithdrawal(db, env, job.id);
          } catch {
            failed = true;
          }
        if (failed) throw new Error('WITHDRAWAL_ERASURE_INCOMPLETE');
      })(),
      retryInstanceDeletions(db, env.GAME_ROOM),
      expireRoomReviews(db, env.GAME_ROOM),
      eraseResultNames(db),
      db
        .delete(guestSessions)
        .where(lte(guestSessions.expiresAt, new Date().toISOString())),
    ]);
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('MAINTENANCE_INCOMPLETE');
  } finally {
    await close();
  }
}
export default {
  async fetch(request: Request, env: ErasureEnv) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/status') {
      const { db, close } = connectDatabase(
        env.ERASURE_DATABASE_URL,
        env.DATABASE_CA_CERT,
        false,
      );
      try {
        const [withdrawals] = await db
          .select({
            pendingAuthentication: sql<number>`count(*) filter (where ${accountWithdrawals.authDeletedAt} is null)::int`,
            pendingAnonymization: sql<number>`count(*) filter (where ${accountWithdrawals.erasedAt} is null)::int`,
            overdueWithdrawals: sql<number>`count(*) filter (where ${accountWithdrawals.erasedAt} is null and ${accountWithdrawals.requestedAt} <= now() - interval '30 days')::int`,
            oldestWithdrawalRequestedAt: sql<
              string | null
            >`min(${accountWithdrawals.requestedAt}) filter (where ${accountWithdrawals.erasedAt} is null)`,
          })
          .from(accountWithdrawals);
        const [deletions] = await db
          .select({ pendingInstanceDeletion: sql<number>`count(*)::int` })
          .from(instanceDeletions)
          .where(isNull(instanceDeletions.deletedAt));
        const [inventory] = await db
          .select({
            unreconciledInstances: sql<number>`count(*) filter (where not ${instances.roomInventoryComplete})::int`,
          })
          .from(instances);
        return Response.json({ ...withdrawals, ...deletions, ...inventory });
      } finally {
        await close();
      }
    }
    if (request.method === 'POST' && new URL(request.url).pathname === '/maintenance') {
      await run(env);
      return Response.json({ ok: true });
    }
    if (request.method === 'POST' && new URL(request.url).pathname === '/inventory')
      return Response.json({ ready: await run(env, undefined, false, true) });
    if (
      request.method !== 'POST' ||
      !['/withdrawal', '/instance'].includes(new URL(request.url).pathname)
    )
      return new Response(null, { status: 404 });
    const body = await request.text();
    if (body.length > 256) return new Response(null, { status: 413 });
    const input = JSON.parse(body) as { operationId?: unknown };
    if (
      typeof input?.operationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        input.operationId,
      )
    )
      return new Response(null, { status: 400 });
    try {
      const ready = await run(
        env,
        input.operationId,
        new URL(request.url).pathname === '/instance',
      );
      return Response.json({ ready }, { status: ready ? 200 : 503 });
    } catch (error) {
      if (error instanceof Error && error.message === 'RESULT_OR_MATCH_PENDING')
        return Response.json({ code: error.message }, { status: 409 });
      throw error;
    }
  },
  async scheduled(_event: ScheduledController, env: ErasureEnv) {
    await run(env);
  },
};
