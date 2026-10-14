import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { FederationMetadata } from '../../shared/federation.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, type Database, rowsD1 } from '../db/d1.ts';
import {
  federationMetadata,
  federationMetadataJobs,
  federationPeers,
  instances,
  organizations,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import {
  canViewInstance,
  OrganizationError,
  validId,
  validName,
} from '../organization/access.ts';
import { organizationIdentity, resolveInstance } from '../organization/database.ts';
import { receivingParticipation } from './admission.ts';
import { federationDatabase, requestPeer } from './transport.ts';

export const METADATA_PATH = '/federation/v1/metadata';
export async function localMetadata(
  db: Database,
  peerOrigin: string,
  input: unknown,
): Promise<FederationMetadata> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        !['sourceInstanceId', 'cursor', 'snapshot', 'targetInstanceId'].includes(key),
    )
  )
    throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
  const sourceInstanceId = validId(value.sourceInstanceId),
    targetInstanceId =
      value.targetInstanceId === undefined ? undefined : validId(value.targetInstanceId),
    cursor = value.cursor ? validId(value.cursor) : undefined;
  if (
    (value.snapshot !== undefined &&
      (typeof value.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot))) ||
    (cursor && !value.snapshot)
  )
    throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
  const organizationId = db
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(organizations.id)
    .limit(1);
  // One transactional batch keeps the snapshot consistent without several D1 round trips.
  const [[peer], [organization], page, [facts]] = await db.batch([
    db.select().from(federationPeers).where(eq(federationPeers.origin, peerOrigin)),
    db.select().from(organizations).orderBy(organizations.id).limit(1),
    db
      .select()
      .from(instances)
      .where(
        and(
          inArray(instances.organizationId, organizationId),
          eq(instances.state, 'published'),
          targetInstanceId ? eq(instances.id, targetInstanceId) : undefined,
          cursor ? gt(instances.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(instances.id))
      .limit(101),
    db
      .select({
        value: sql<string>`coalesce(json_group_array(json_array(${instances.id},${instances.operationRevision},${instances.name},${instances.rankedPauseReason},${instances.casualPauseReason},${instances.casualConfig})), '[]')`,
      })
      .from(instances)
      .where(
        and(
          inArray(instances.organizationId, organizationId),
          eq(instances.state, 'published'),
          targetInstanceId ? eq(instances.id, targetInstanceId) : undefined,
        ),
      ),
  ]);
  if (!organization) throw new OrganizationError('SETUP_REQUIRED', 409);
  if (!peer || (!peer.approved && organization.externalParticipation !== 'unblocked'))
    throw new OrganizationError('UNAPPROVED_PEER', 403);
  const snapshot = await contentHash({
    organization,
    instances: (JSON.parse(facts.value) as [string, ...unknown[]][]).sort(
      ([left], [right]) => left.localeCompare(right),
    ),
    peer: {
      approved: peer.approved,
      blocked: peer.participationBlocked,
      ranked: peer.receiveRanked,
      casual: peer.receiveCasual,
    },
  });
  if (value.snapshot && value.snapshot !== snapshot)
    throw new OrganizationError('FEDERATION_SNAPSHOT_CHANGED', 409);
  const ranked = receivingParticipation(organization, peer, 'ranked'),
    casual = receivingParticipation(organization, peer, 'casual');
  return {
    snapshot,
    sourceInstanceId,
    organization: { id: organization.id, name: organization.name },
    instances: page.slice(0, 100).map((instance) => ({
      id: instance.id,
      name: instance.name,
      ranked: ranked && !instance.rankedPauseReason,
      casual: casual && !instance.casualPauseReason && instance.casualConfig.enabled,
    })),
    nextCursor: page.length > 100 ? page[99].id : null,
  };
}
export function parseMetadata(value: unknown, instanceId: string): FederationMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('FEDERATION_METADATA_INVALID', 503);
  const metadata = value as FederationMetadata;
  try {
    if (
      Object.keys(metadata).sort().join(',') !==
        'instances,nextCursor,organization,snapshot,sourceInstanceId' ||
      !/^[a-f0-9]{64}$/.test(metadata.snapshot) ||
      metadata.sourceInstanceId !== instanceId ||
      Object.keys(metadata.organization).sort().join(',') !== 'id,name' ||
      !Array.isArray(metadata.instances) ||
      metadata.instances.length > 100
    )
      throw new Error('SCHEMA');
    validId(metadata.organization.id);
    validName(metadata.organization.name);
    if (metadata.nextCursor !== null) validId(metadata.nextCursor);
    for (const instance of metadata.instances) {
      if (
        Object.keys(instance).sort().join(',') !== 'casual,id,name,ranked' ||
        typeof instance.ranked !== 'boolean' ||
        typeof instance.casual !== 'boolean'
      )
        throw new Error('SCHEMA');
      validId(instance.id);
      validName(instance.name);
    }
    if (
      new Set(metadata.instances.map((instance) => instance.id)).size !==
      metadata.instances.length
    )
      throw new Error('DUPLICATE');
  } catch {
    throw new OrganizationError('FEDERATION_METADATA_INVALID', 503);
  }
  return metadata;
}
export async function syncPeerMetadata(
  env: Env,
  subject: string,
  input: Record<string, unknown>,
) {
  if (
    Object.keys(input).some(
      (key) => !['operation', 'instanceId', 'peerOrigin', 'cursor'].includes(key),
    )
  )
    throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
  const db = federationDatabase(env),
    identity = await organizationIdentity(db, subject),
    instanceId =
      input.instanceId === undefined
        ? identity.organization.id
        : validId(input.instanceId),
    peerOrigin = String(input.peerOrigin),
    cursor = input.cursor ? validId(input.cursor) : undefined;
  if (instanceId !== identity.organization.id) {
    const { instance, account, permissions } = await resolveInstance(
      db,
      subject,
      instanceId,
    );
    if (!canViewInstance(instance.state, account.administrator, permissions))
      throw new OrganizationError('INSTANCE_PREPARING', 409);
  }
  return refreshFederationMetadata(env, instanceId, peerOrigin, cursor, subject);
}
export async function refreshScheduledFederationMetadata(
  env: Env,
  instanceId: string,
  peerOrigin: string,
) {
  const [cached] = await federationDatabase(env)
    .select()
    .from(federationMetadata)
    .where(
      and(
        eq(federationMetadata.instanceId, instanceId),
        eq(federationMetadata.peerOrigin, peerOrigin),
      ),
    );
  return refreshFederationMetadata(
    env,
    instanceId,
    peerOrigin,
    cached?.errorCode ? undefined : (cached?.nextCursor ?? undefined),
  );
}
// Scheduled callers are internal; HTTP callers must first prove access to the source.
async function refreshFederationMetadata(
  env: Env,
  instanceId: string,
  peerOrigin: string,
  cursor?: string,
  subject?: string,
) {
  const db = federationDatabase(env),
    attemptId = crypto.randomUUID();
  const key = and(
    eq(federationMetadata.instanceId, instanceId),
    eq(federationMetadata.peerOrigin, peerOrigin),
  );
  const jobKey = and(
    eq(federationMetadataJobs.instanceId, instanceId),
    eq(federationMetadataJobs.peerOrigin, peerOrigin),
  );
  const previous = await changeD1(db, async (writes) => {
    const [[scope], [organization], [peer], [job], [cached]] = await db.batch([
      db.select().from(instances).where(eq(instances.id, instanceId)),
      db.select().from(organizations).where(eq(organizations.id, instanceId)),
      db.select().from(federationPeers).where(eq(federationPeers.origin, peerOrigin)),
      db.select().from(federationMetadataJobs).where(jobKey),
      db.select().from(federationMetadata).where(key),
    ]);
    if (!organization && (!scope || scope.state === 'archived'))
      throw new OrganizationError('FEDERATION_TARGET_UNAVAILABLE', 409);
    if (!peer?.approved) throw new OrganizationError('UNAPPROVED_PEER', 403);
    if (job && job.leaseUntil > Date.now())
      throw new OrganizationError('FEDERATION_SYNC_BUSY', 409);
    if (cursor && (!cached || cached.nextCursor !== cursor))
      throw new OrganizationError('FEDERATION_CONFLICT', 409);
    writes.push(
      rowsD1(
        federationMetadataJobs,
        [
          {
            instanceId,
            peerOrigin,
            attemptId,
            leaseUntil: Date.now() + 10000,
            nextAttemptAt: Date.now() + 60000,
          },
        ],
        true,
      ),
    );
    return cached;
  });
  try {
    const response = await requestPeer(
      env,
      peerOrigin,
      METADATA_PATH,
      'metadata.request',
      'metadata.response',
      {
        sourceInstanceId: instanceId,
        ...(cursor ? { cursor, snapshot: previous?.payload.snapshot } : {}),
      },
    );
    const page = parseMetadata(response.body, instanceId);
    if (
      cursor &&
      (page.snapshot !== previous?.payload.snapshot ||
        page.instances.some(
          (row, index) => row.id <= (index ? page.instances[index - 1].id : cursor),
        ))
    )
      throw new OrganizationError('FEDERATION_SNAPSHOT_CHANGED', 409);
    await changeD1(db, async (writes) => {
      const [[scope], [organization], [job], [peer], [latest]] = await db.batch([
        db.select().from(instances).where(eq(instances.id, instanceId)),
        db.select().from(organizations).where(eq(organizations.id, instanceId)),
        db.select().from(federationMetadataJobs).where(jobKey),
        db.select().from(federationPeers).where(eq(federationPeers.origin, peerOrigin)),
        db.select().from(federationMetadata).where(key),
      ]);
      if (subject) {
        if (instanceId !== (await organizationIdentity(db, subject)).organization.id) {
          const current = await resolveInstance(db, subject, instanceId);
          if (
            !canViewInstance(
              current.instance.state,
              current.account.administrator,
              current.permissions,
            )
          )
            throw new OrganizationError('FEDERATION_TARGET_UNAVAILABLE', 409);
        }
      } else {
        if (!organization && (!scope || scope.state === 'archived'))
          throw new OrganizationError('FEDERATION_TARGET_UNAVAILABLE', 409);
      }
      if (job?.attemptId !== attemptId)
        throw new OrganizationError('FEDERATION_CONFLICT', 409);
      if (!peer?.approved) throw new OrganizationError('UNAPPROVED_PEER', 403);
      if (
        cursor &&
        (latest?.lastSuccessAt !== previous?.lastSuccessAt ||
          latest?.nextCursor !== cursor)
      )
        throw new OrganizationError('FEDERATION_CONFLICT', 409);
      const payload = {
        ...page,
        instances:
          cursor && latest
            ? [...latest.payload.instances, ...page.instances]
            : page.instances,
      };
      if (
        new Set(payload.instances.map((row) => row.id)).size !== payload.instances.length
      )
        throw new OrganizationError('FEDERATION_METADATA_INVALID', 503);
      writes.push(
        rowsD1(
          federationMetadata,
          [
            {
              instanceId,
              peerOrigin,
              payload,
              nextCursor: page.nextCursor,
              lastSuccessAt: Date.now(),
              errorCode: null,
            },
          ],
          true,
        ),
      );
      writes.push(
        db
          .update(federationMetadataJobs)
          .set({
            attemptId: null,
            leaseUntil: 0,
            failures: 0,
            errorCode: null,
            // Cron already limits refreshes to one pass per minute. Rounding a late
            // completion forward can skip the next tick and expire the 90s cache.
            nextAttemptAt: Date.now(),
          })
          .where(jobKey),
      );
    });
    return { ok: true, nextCursor: page.nextCursor };
  } catch (error) {
    await changeD1(db, async (writes) => {
      const [job] = await db.select().from(federationMetadataJobs).where(jobKey);
      if (job?.attemptId !== attemptId) return;
      const code =
        error instanceof OrganizationError ? error.code : 'FEDERATION_PEER_UNAVAILABLE';
      const delay = Math.min(900000, 1000 * 2 ** Math.min(job.failures, 20));
      writes.push(
        db
          .update(federationMetadataJobs)
          .set({
            attemptId: null,
            leaseUntil: 0,
            failures: job.failures + 1,
            errorCode: code,
            nextAttemptAt: Math.max(
              error instanceof OrganizationError ? (error.retryAt ?? 0) : 0,
              Date.now() + delay + Math.floor((Math.random() * delay) / 4),
            ),
          })
          .where(jobKey),
      );
      if (previous)
        writes.push(
          db
            .update(federationMetadata)
            .set({
              errorCode: code,
              ...(['FEDERATION_SNAPSHOT_CHANGED', 'INVALID_FEDERATION_REQUEST'].includes(
                code,
              )
                ? { nextCursor: null }
                : {}),
            })
            .where(key),
        );
    });
    throw error;
  }
}
