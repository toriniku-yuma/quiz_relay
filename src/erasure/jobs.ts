import { eq } from 'drizzle-orm';
import { changeD1, type Database } from '../worker/db/d1.ts';
import {
  organizationAccounts as accounts,
  accountWithdrawals as jobs,
} from '../worker/db/schema.ts';

type DeleteUser = (subject: string) => Promise<void>;

export async function eraseAuthentication(
  db: Database,
  operationId: string,
  remove: DeleteUser,
) {
  const claim = await changeD1(db, async (writes) => {
    const [job] = await db
      .select({
        id: jobs.id,
        attempts: jobs.attempts,
        deleted: jobs.authDeletedAt,
        retryAt: jobs.retryAt,
        subject: accounts.subject,
        withdrawn: accounts.withdrawnAt,
      })
      .from(jobs)
      .innerJoin(accounts, eq(accounts.actorId, jobs.actorId))
      .where(eq(jobs.id, operationId));
    if (!job?.withdrawn) return { ready: false } as const;
    if (job.deleted) return { ready: true } as const;
    if (Date.parse(job.retryAt) > Date.now()) return { ready: false } as const;
    const attempts = job.attempts + 1;
    writes.push(
      db
        .update(jobs)
        .set({ attempts, retryAt: new Date(Date.now() + 60000).toISOString() })
        .where(eq(jobs.id, operationId)),
    );
    return { job, attempts };
  });
  if ('ready' in claim) return claim.ready;
  let removed = false;
  try {
    await remove(claim.job.subject);
    removed = true;
  } catch {
    /* The committed claim keeps retries bounded even if this process stops. */
  }
  return changeD1(db, async (writes) => {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, operationId));
    if (!job) return false;
    if (job.authDeletedAt) return true;
    if (job.attempts !== claim.attempts) return false;
    writes.push(
      db
        .update(jobs)
        .set(
          removed
            ? { authDeletedAt: new Date().toISOString() }
            : {
                retryAt: new Date(
                  Date.now() +
                    Math.min(3600000, 60000 * 2 ** Math.min(claim.attempts - 1, 6)),
                ).toISOString(),
              },
        )
        .where(eq(jobs.id, operationId)),
    );
    return removed;
  });
}
