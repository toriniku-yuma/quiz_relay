import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { changeD1, connectD1 } from './db/d1.ts';
import {
  accountWithdrawals,
  difficultySamples,
  federationMetadataJobs,
  federationPeers,
  federationQuestionImports,
  federationQuestionSources,
  instanceDeletions,
  instances,
  maintenanceCheckpoints,
  organizations,
  questionDifficulty,
  resultPrivacyJobs,
} from './db/schema.ts';
import type { Env } from './env.ts';
import { dueControlEvents, pendingControlEvents } from './federation/controls.ts';
import { dueQuestionImports } from './federation/question-imports.ts';
import { dueQuestionSources } from './federation/question-sources.ts';
import { dueResultDeliveries } from './federation/results.ts';
import { federationEnabled } from './federation/transport.ts';
import { failureCode } from './http/diagnostics.ts';

export async function scheduledD1(
  env: Env,
  now = Date.now(),
  frequency: 'hourly' | 'daily' = 'hourly',
) {
  if (!env.GAME_D1 || !env.ACCOUNT_ERASURE)
    throw new Error('MAINTENANCE_CONFIGURATION_REQUIRED');
  const db = connectD1(env.GAME_D1),
    time = new Date(now).toISOString(),
    day = time.slice(0, 10);
  const tasks: Record<string, unknown>[] = [];
  if (frequency === 'hourly' && federationEnabled(env)) {
    // Deliver saved results before optional synchronization and cleanup work.
    tasks.push(
      ...(await dueResultDeliveries(db, now)).map((job) => ({
        task: 'federationResult',
        ...job,
      })),
    );
    tasks.push({ task: 'federationReservations' });
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
      );
    tasks.push(...due.map((job) => ({ task: 'federationMetadata', ...job })));
  }
  if (frequency === 'hourly') {
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
      .where(isNull(instanceDeletions.deletedAt))
      .orderBy(instanceDeletions.lastAttemptAt, instanceDeletions.id)
      .limit(2);
    tasks.push(...deletions.map((job) => ({ task: 'instance', operationId: job.id })));
    const [privacy] = await db
      .select({ id: resultPrivacyJobs.matchId })
      .from(resultPrivacyJobs)
      .where(lte(resultPrivacyJobs.dueAt, `${day}T00:00:00.000Z`))
      .limit(1);
    if (privacy) tasks.push({ task: 'results' });
    tasks.push(
      ...withdrawals.map((job) => ({ task: 'anonymization', operationId: job.id })),
    );
  }
  if (federationEnabled(env)) {
    // Persist the daily trigger before dispatch so an interrupted invocation can resume hourly.
    if (frequency === 'daily')
      await changeD1(db, async (writes) => {
        writes.push(
          db
            .update(federationQuestionSources)
            .set({ nextAttemptAt: now })
            .where(
              and(
                eq(federationQuestionSources.nextAttemptAt, 0),
                lte(federationQuestionSources.leaseUntil, now),
              ),
            ),
          db
            .update(federationQuestionImports)
            .set({ nextAttemptAt: now })
            .where(
              and(
                eq(federationQuestionImports.enabled, true),
                eq(federationQuestionImports.nextAttemptAt, 0),
                lte(federationQuestionImports.leaseUntil, now),
              ),
            ),
        );
      });
    tasks.push(
      ...(await dueQuestionSources(env, now, frequency === 'hourly')).map((source) => ({
        task: 'federationQuestionSource',
        ...source,
      })),
    );
    tasks.push(
      ...(await dueQuestionImports(env, now, frequency === 'hourly')).map((job) => ({
        task: 'federationQuestions',
        importId: job.id,
      })),
    );
  }
  if (frequency === 'daily') {
    tasks.push({ task: 'results' });
    if (federationEnabled(env))
      tasks.push(
        { task: 'federationNonces' },
        { task: 'federationSessions' },
        { task: 'sharedQuestionRetention' },
      );
    const [retention] = await db
      .select()
      .from(maintenanceCheckpoints)
      .where(eq(maintenanceCheckpoints.id, 'retention'));
    if (retention?.completedDay !== day) tasks.push({ task: 'retention' });
    if (env.QUESTION_DIFFICULTY_ENABLED === 'true') {
      const scopes = await db
        .select({ id: instances.id })
        .from(instances)
        .where(
          and(
            sql`${instances.state}<>'archived'`,
            sql`exists(select 1 from ${questionDifficulty} where ${questionDifficulty.instanceId}=${instances.id} and (${questionDifficulty.lastDay} is null or ${questionDifficulty.lastDay}<>${day}) and ${questionDifficulty.statisticsRevision}<>coalesce((select sum(${difficultySamples.trials}) from ${difficultySamples} where ${difficultySamples.owner}=${instances.owner} and ${difficultySamples.generation}=${questionDifficulty.generation}),0))`,
          ),
        )
        .orderBy(instances.id);
      tasks.push(
        ...scopes.map((scope) => ({ task: 'difficulty', instanceId: scope.id })),
      );
    }
  }
  let failed = false;
  const runId = crypto.randomUUID();
  // Serial dispatch avoids making every private batch compete over the same revision.
  for (const [taskIndex, task] of tasks.entries()) {
    const context = { runId, frequency, taskIndex, task: task.task };
    let outcome: 'ok' | 'pending' | 'failed' = 'failed';
    console.log(
      JSON.stringify({
        event: 'maintenance_task',
        ...context,
        phase: 'start',
        at: Date.now(),
      }),
    );
    try {
      const response = await env.ACCOUNT_ERASURE.fetch(
        'https://account-erasure.internal/maintenance',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(task),
        },
      );
      // Drain successful service responses too, before dispatching the next task.
      const body: unknown = await response.json();
      const pending =
        response.status === 503 &&
        body !== null &&
        typeof body === 'object' &&
        Object.keys(body).join(',') === 'ready' &&
        'ready' in body &&
        body.ready === false;
      outcome = response.ok ? 'ok' : pending ? 'pending' : 'failed';
      if (!response.ok) {
        if (!pending) {
          const code =
            body !== null && typeof body === 'object' && 'code' in body
              ? body.code
              : undefined;
          failed = true;
          console.error(
            JSON.stringify({
              event: 'maintenance_task_failed',
              ...context,
              code:
                typeof code === 'string' && /^[A-Z_]{3,80}$/.test(code)
                  ? code
                  : 'MAINTENANCE_FAILED',
            }),
          );
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'maintenance_task_failed',
          ...context,
          code: failureCode(error),
        }),
      );
      failed = true;
    } finally {
      console.log(
        JSON.stringify({
          event: 'maintenance_task',
          ...context,
          phase: 'end',
          outcome,
          at: Date.now(),
        }),
      );
    }
  }
  if (failed) throw new Error('MAINTENANCE_INCOMPLETE');
}
