import { and, eq, lte, sql } from 'drizzle-orm';
import { API_PATHS } from '../../shared/api-paths.ts';
import { QUESTION_SYNC_INTERVAL_MS } from '../../shared/federation-questions.ts';
import { changeD1, type Database } from '../db/d1.ts';
import {
  federationPeers,
  federationPolicies,
  federationQuestionSources,
  instances,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError, validId, validName } from '../organization/access.ts';
import { exportSharedQuestions } from './question-source.ts';
import { federationDatabase, requestPeer } from './transport.ts';

type Source = typeof federationQuestionSources.$inferSelect;
const sourceKey = (
  source: Pick<Source, 'instanceId' | 'peerOrigin' | 'sourceInstanceId'>,
) =>
  and(
    eq(federationQuestionSources.instanceId, source.instanceId),
    eq(federationQuestionSources.peerOrigin, source.peerOrigin),
    eq(federationQuestionSources.sourceInstanceId, source.sourceInstanceId),
  );
async function requireSource(
  db: Database,
  source: Pick<Source, 'instanceId' | 'peerOrigin' | 'sourceInstanceId'>,
) {
  const [row] = await db
    .select({ permissions: federationPolicies.permissions })
    .from(federationPolicies)
    .innerJoin(federationPeers, eq(federationPeers.origin, federationPolicies.peerOrigin))
    .innerJoin(instances, eq(instances.id, federationPolicies.instanceId))
    .where(
      and(
        eq(federationPolicies.instanceId, source.instanceId),
        eq(federationPolicies.peerOrigin, source.peerOrigin),
        eq(federationPolicies.peerInstanceId, source.sourceInstanceId),
        eq(federationPeers.approved, true),
        sql`${instances.state}<>'archived'`,
      ),
    );
  if (!row?.permissions.receive.questions)
    throw new OrganizationError('QUESTION_IMPORT_DENIED', 403);
}
export async function cachedQuestionSource(
  db: Database,
  source: Pick<Source, 'instanceId' | 'peerOrigin' | 'sourceInstanceId'>,
) {
  return changeD1(db, async (writes) => {
    await requireSource(db, source);
    const [cached] = await db
      .select()
      .from(federationQuestionSources)
      .where(sourceKey(source));
    if (!cached) writes.push(db.insert(federationQuestionSources).values(source));
    return {
      categories: cached?.categories ?? [],
      ready: !!cached?.lastSuccessAt,
      errorCode: cached?.errorCode ?? null,
    };
  });
}
export async function refreshQuestionSource(
  env: Env,
  source: Pick<Source, 'instanceId' | 'peerOrigin' | 'sourceInstanceId'>,
) {
  const db = federationDatabase(env),
    leaseUntil = Date.now() + 15000;
  const claimed = await changeD1(db, async (writes) => {
    await requireSource(db, source);
    const [cached] = await db
      .select()
      .from(federationQuestionSources)
      .where(sourceKey(source));
    if (!cached || cached.nextAttemptAt > Date.now() || cached.leaseUntil > Date.now())
      return false;
    writes.push(
      db.update(federationQuestionSources).set({ leaseUntil }).where(sourceKey(source)),
    );
    return true;
  });
  if (!claimed) return;
  try {
    const request = {
      sourceInstanceId: source.sourceInstanceId,
      targetInstanceId: source.instanceId,
      categoriesOnly: true,
    };
    const body =
      source.peerOrigin === env.FEDERATION_ORIGIN
        ? await exportSharedQuestions(db, source.peerOrigin, request)
        : (
            await requestPeer(
              env,
              source.peerOrigin,
              API_PATHS.federationQuestionSync,
              'questions.request',
              'questions.response',
              request,
            )
          ).body;
    const page = body as {
      sourceInstanceId: string;
      targetInstanceId: string;
      categories: { id: string; name: string }[];
    };
    if (
      !page ||
      page.sourceInstanceId !== source.sourceInstanceId ||
      page.targetInstanceId !== source.instanceId ||
      !Array.isArray(page.categories) ||
      page.categories.length > 1000
    )
      throw new OrganizationError('INVALID_SHARED_QUESTIONS', 503);
    for (const category of page.categories) {
      validId(category.id);
      validName(category.name);
    }
    if (
      new Set(page.categories.map((category) => category.id)).size !==
      page.categories.length
    )
      throw new OrganizationError('INVALID_SHARED_QUESTIONS', 503);
    await changeD1(db, async (writes) => {
      await requireSource(db, source);
      writes.push(
        db
          .update(federationQuestionSources)
          .set({
            categories: page.categories.map(({ id, name }) => ({ id, name })),
            lastSuccessAt: Date.now(),
            nextAttemptAt: Date.now() + QUESTION_SYNC_INTERVAL_MS,
            leaseUntil: 0,
            errorCode: null,
          })
          .where(
            and(sourceKey(source), eq(federationQuestionSources.leaseUntil, leaseUntil)),
          ),
      );
    });
  } catch (error) {
    await changeD1(db, async (writes) => {
      writes.push(
        db
          .update(federationQuestionSources)
          .set({
            leaseUntil: 0,
            nextAttemptAt: Date.now() + QUESTION_SYNC_INTERVAL_MS,
            errorCode:
              error instanceof OrganizationError
                ? error.code
                : 'QUESTION_SYNC_UNAVAILABLE',
          })
          .where(
            and(sourceKey(source), eq(federationQuestionSources.leaseUntil, leaseUntil)),
          ),
      );
    });
    throw error;
  }
}
export async function dueQuestionSources(env: Env, now: number) {
  return federationDatabase(env)
    .select({
      instanceId: federationQuestionSources.instanceId,
      peerOrigin: federationQuestionSources.peerOrigin,
      sourceInstanceId: federationQuestionSources.sourceInstanceId,
    })
    .from(federationQuestionSources)
    .innerJoin(
      federationPolicies,
      and(
        eq(federationPolicies.instanceId, federationQuestionSources.instanceId),
        eq(federationPolicies.peerOrigin, federationQuestionSources.peerOrigin),
        eq(federationPolicies.peerInstanceId, federationQuestionSources.sourceInstanceId),
      ),
    )
    .innerJoin(
      federationPeers,
      eq(federationPeers.origin, federationQuestionSources.peerOrigin),
    )
    .innerJoin(instances, eq(instances.id, federationQuestionSources.instanceId))
    .where(
      and(
        lte(federationQuestionSources.nextAttemptAt, now),
        lte(federationQuestionSources.leaseUntil, now),
        eq(federationPeers.approved, true),
        sql`${instances.state}<>'archived'`,
        sql`json_extract(${federationPolicies.permissions},'$.receive.questions')=1`,
      ),
    )
    .orderBy(federationQuestionSources.nextAttemptAt)
    .limit(2);
}
