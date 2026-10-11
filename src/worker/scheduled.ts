import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { connectD1 } from './db/d1.ts';
import {
  accountWithdrawals,
  difficultyBackfills,
  difficultySamples,
  federationMetadataJobs,
  federationPeers,
  instanceDeletions,
  instances,
  maintenanceCheckpoints,
  organizations,
  questionDifficulty,
  resultPrivacyJobs,
  roomInventoryScans,
} from './db/schema.ts';
import type { Env } from './env.ts';
import { dueControlEvents, pendingControlEvents } from './federation/controls.ts';
import { refreshScheduledFederationMetadata } from './federation/metadata.ts';
import { dueQuestionImports } from './federation/question-imports.ts';
import {
  dueQuestionSources,
  refreshQuestionSource,
} from './federation/question-sources.ts';
import { dueResultDeliveries } from './federation/results.ts';
import { failureCode } from './http/handlers.ts';

export async function scheduledD1(env: Env, now = Date.now()) {
  if (!env.GAME_D1 || !env.ACCOUNT_ERASURE)
    throw new Error('MAINTENANCE_CONFIGURATION_REQUIRED');
  const db = connectD1(env.GAME_D1),
    time = new Date(now).toISOString(),
    day = time.slice(0, 10);
  const tasks: Record<string, unknown>[] = [];
  if (env.FEDERATION_ORIGIN && env.SIGNING_KID && env.SIGNING_PRIVATE_KEY) {
    // Deliver saved results before optional synchronization and cleanup work.
    tasks.push(
      ...(await dueResultDeliveries(db, now)).map((job) => ({
        task: 'federationResult',
        ...job,
      })),
    );
    tasks.push({ task: 'federationNonces' });
    tasks.push({ task: 'federationSessions' });
    tasks.push({ task: 'sharedQuestionRetention' });
    tasks.push(
      ...(await dueQuestionSources(env, now)).map((source) => ({
        task: 'federationQuestionSource',
        ...source,
      })),
    );
    tasks.push(
      ...(await dueQuestionImports(env, now)).map((job) => ({
        task: 'federationQuestions',
        importId: job.id,
      })),
    );
    tasks.push(
      ...(await dueControlEvents(db, now)).map((job) => ({
        task: 'federationControl',
        ...job,
      })),
      ...(await pendingControlEvents(db)).map((job) => ({
        task: 'federationControlApply',
        ...job,
      })),
    );
    const due = await db
      .select({
        instanceId: federationMetadataJobs.instanceId,
        peerOrigin: federationMetadataJobs.peerOrigin,
      })
      .from(federationMetadataJobs)
      .innerJoin(
        federationPeers,
        eq(federationPeers.origin, federationMetadataJobs.peerOrigin),
      )
      .leftJoin(instances, eq(instances.id, federationMetadataJobs.instanceId))
      .leftJoin(organizations, eq(organizations.id, federationMetadataJobs.instanceId))
      .where(
        and(
          eq(federationPeers.approved, true),
          or(sql`${instances.state}<>'archived'`, sql`${organizations.id} is not null`),
          lte(federationMetadataJobs.nextAttemptAt, now),
          lte(federationMetadataJobs.leaseUntil, now),
        ),
      )
      .orderBy(
        federationMetadataJobs.nextAttemptAt,
        federationMetadataJobs.instanceId,
        federationMetadataJobs.peerOrigin,
      )
      .limit(4);
    tasks.push(...due.map((job) => ({ task: 'federationMetadata', ...job })));
  }
  const authentication = await db
    .select({ id: accountWithdrawals.id })
    .from(accountWithdrawals)
    .where(
      and(
        isNull(accountWithdrawals.authDeletedAt),
        lte(accountWithdrawals.retryAt, time),
      ),
    )
    .orderBy(accountWithdrawals.retryAt, accountWithdrawals.id)
    .limit(2);
  tasks.push(
    ...authentication.map((job) => ({ task: 'authentication', operationId: job.id })),
  );
  const withdrawals = await db
    .select({ id: accountWithdrawals.id })
    .from(accountWithdrawals)
    .where(isNull(accountWithdrawals.erasedAt))
    .orderBy(accountWithdrawals.lastAttemptAt, accountWithdrawals.id)
    .limit(2);
  const deletions = await db
    .select({ id: instanceDeletions.id })
    .from(instanceDeletions)
    .where(
      or(
        isNull(instanceDeletions.deletedAt),
        eq(instanceDeletions.inventoryPending, true),
      ),
    )
    .orderBy(instanceDeletions.lastAttemptAt, instanceDeletions.id)
    .limit(2);
  const [inventory] = await db.all<{ pending: number }>(
    sql`select exists(select 1 from ${instances} where ${instances.roomInventoryComplete}=0) or exists(select 1 from ${roomInventoryScans}) or exists(select 1 from ${instanceDeletions} where ${instanceDeletions.inventoryPending}=1) as pending`,
  );
  if (inventory.pending) tasks.push({ task: 'inventory' });
  tasks.push(...deletions.map((job) => ({ task: 'instance', operationId: job.id })));
  const [privacy] = await db
    .select({ id: resultPrivacyJobs.resultId })
    .from(resultPrivacyJobs)
    .where(lte(resultPrivacyJobs.dueAt, time))
    .limit(1);
  if (privacy) tasks.push({ task: 'results' }, { task: 'results' });
  tasks.push(
    ...withdrawals.map((job) => ({ task: 'anonymization', operationId: job.id })),
  );
  const [retention] = await db
    .select()
    .from(maintenanceCheckpoints)
    .where(eq(maintenanceCheckpoints.id, 'retention'));
  if (retention?.completedDay !== day) tasks.push({ task: 'retention' });
  tasks.push({ task: 'reviews' });
  if (env.QUESTION_DIFFICULTY_ENABLED === 'true') {
    const scopes = await db
      .select({ id: instances.id })
      .from(instances)
      .where(
        and(
          sql`${instances.state}<>'archived'`,
          sql`(not exists(select 1 from ${difficultyBackfills} where ${difficultyBackfills.owner}=${instances.owner} and ${difficultyBackfills.complete}=1) or exists(select 1 from ${questionDifficulty} where ${questionDifficulty.instanceId}=${instances.id} and (${questionDifficulty.lastDay} is null or ${questionDifficulty.lastDay}<>${day}) and ${questionDifficulty.statisticsRevision}<>coalesce((select sum(${difficultySamples.trials}) from ${difficultySamples} where ${difficultySamples.owner}=${instances.owner} and ${difficultySamples.generation}=${questionDifficulty.generation}),0)))`,
        ),
      )
      .orderBy(instances.id)
      .limit(2);
    tasks.push(...scopes.map((scope) => ({ task: 'difficulty', instanceId: scope.id })));
  }
  let failed = false;
  // Serial dispatch avoids making every private batch compete over the same revision.
  for (const task of tasks) {
    console.log(
      JSON.stringify({
        event: 'maintenance_task',
        task: task.task,
        phase: 'start',
        at: Date.now(),
      }),
    );
    try {
      if (task.task === 'federationQuestionSource') {
        await refreshQuestionSource(env, {
          instanceId: task.instanceId as string,
          peerOrigin: task.peerOrigin as string,
          sourceInstanceId: task.sourceInstanceId as string,
        });
        continue;
      }
      // Metadata signing and snapshot planning can exceed Free HTTP workers' CPU limit.
      // This scheduler already runs in the dedicated maintenance Durable Object.
      if (task.task === 'federationMetadata') {
        await refreshScheduledFederationMetadata(
          env,
          task.instanceId as string,
          task.peerOrigin as string,
        );
        continue;
      }
      const response = await env.ACCOUNT_ERASURE.fetch(
        'https://account-erasure.internal/maintenance',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(task),
        },
      );
      // Drain successful service responses too, before dispatching the next task.
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      if (!response.ok) {
        if (response.status !== 503 || body.code) {
          failed = true;
          console.error(
            JSON.stringify({
              event: 'maintenance_task_failed',
              task: task.task,
              code:
                typeof body.code === 'string' && /^[A-Z_]{3,80}$/.test(body.code)
                  ? body.code
                  : 'MAINTENANCE_FAILED',
            }),
          );
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'maintenance_task_failed',
          task: task.task,
          code: failureCode(error),
        }),
      );
      failed = true;
    } finally {
      console.log(
        JSON.stringify({
          event: 'maintenance_task',
          task: task.task,
          phase: 'end',
          at: Date.now(),
        }),
      );
    }
  }
  if (failed) throw new Error('MAINTENANCE_INCOMPLETE');
}
