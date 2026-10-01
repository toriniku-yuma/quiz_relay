import { createClient } from '@supabase/supabase-js';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type { connectDatabase } from '../worker/db/connection.ts';
import {
  organizationAccounts as accounts,
  accountWithdrawals as jobs,
} from '../worker/db/schema.ts';
import { erasureBatch } from './limits.ts';
import { eraseResultNames } from './results.ts';

type Database = ReturnType<typeof connectDatabase>['db'];
type DeleteUser = (subject: string) => Promise<void>;

export function authDeletion(url: string, key: string): DeleteUser {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(8000) }),
    },
  });
  return async (subject) => {
    const { error } = await client.auth.admin.deleteUser(subject);
    // A successful deletion with a lost response is safe to retry.
    if (error && error.code !== 'user_not_found') throw new Error('AUTH_ERASURE_FAILED');
  };
}

export async function eraseAuthentication(
  db: Pick<Database, 'transaction'>,
  operationId: string,
  remove: DeleteUser,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`withdrawal:${operationId}`},0))`,
    );
    const [job] = await tx
      .select({
        id: jobs.id,
        attempts: jobs.attempts,
        deleted: jobs.authDeletedAt,
        subject: accounts.subject,
        withdrawn: accounts.withdrawnAt,
      })
      .from(jobs)
      .innerJoin(accounts, eq(accounts.actorId, jobs.actorId))
      .where(eq(jobs.id, operationId));
    if (!job?.withdrawn) return false;
    if (job.deleted) return true;
    try {
      await remove(job.subject);
    } catch {
      await tx
        .update(jobs)
        .set({
          attempts: job.attempts + 1,
          retryAt: new Date(
            Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(job.attempts, 6)),
          ).toISOString(),
        })
        .where(eq(jobs.id, job.id));
      return false;
    }
    await tx
      .update(jobs)
      .set({ authDeletedAt: new Date().toISOString(), attempts: job.attempts + 1 })
      .where(eq(jobs.id, job.id));
    return true;
  });
}

export async function retryAuthentication(db: Database, remove: DeleteUser) {
  const due = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(isNull(jobs.authDeletedAt), lte(jobs.retryAt, new Date().toISOString())))
    .orderBy(jobs.retryAt)
    .limit(erasureBatch.authentication);
  for (const job of due) await eraseAuthentication(db, job.id, remove);
  await eraseResultNames(db);
  await db.execute(sql`select quiz_game.expire_records()`);
}
