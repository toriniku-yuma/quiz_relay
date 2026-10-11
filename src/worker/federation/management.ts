import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { exportSPKI, importSPKI } from 'jose';
import {
  disabledFederationPermissions,
  FEDERATION_FRESH_MS,
  type FederationOverview,
  federationPermissions,
} from '../../shared/federation.ts';
import { changeD1, type Database, readD1, rowsD1 } from '../db/d1.ts';
import {
  federationControlDeliveries,
  federationMetadata,
  federationMetadataJobs,
  federationPeerKeys,
  federationPeers,
  federationPolicies,
  federationResultDeliveries,
  instances,
  organizations,
} from '../db/schema.ts';
import {
  OrganizationError,
  requireAdministrator,
  validId,
  validName,
} from '../organization/access.ts';
import { organizationIdentity } from '../organization/database.ts';
import { peerRequest } from './egress.ts';
import { INBOX_PATH } from './signatures.ts';

function exact(input: Record<string, unknown>, fields: string[]) {
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
}
function revision(input: unknown) {
  if (!Number.isSafeInteger(input) || Number(input) < 0)
    throw new OrganizationError('INVALID_REVISION', 400);
  return Number(input);
}
export async function federationOverview(
  db: Database,
  subject: string,
): Promise<FederationOverview> {
  return readD1(db, async () => {
    const { account, organization } = await organizationIdentity(db, subject);
    requireAdministrator(account);
    const policies = await db
      .select({ policy: federationPolicies })
      .from(federationPolicies)
      .innerJoin(instances, eq(instances.id, federationPolicies.instanceId))
      .where(eq(instances.organizationId, organization.id));
    return {
      administrator: true,
      admission: {
        mode: organization.externalParticipation,
        revision: organization.federationRevision,
      },
      controls: await db
        .select({
          eventId: federationControlDeliveries.eventId,
          peerOrigin: federationControlDeliveries.peerOrigin,
          attempts: federationControlDeliveries.attempts,
          nextAttemptAt: federationControlDeliveries.nextAttemptAt,
          receivedAt: federationControlDeliveries.receivedAt,
          appliedAt: federationControlDeliveries.appliedAt,
          errorCode: federationControlDeliveries.errorCode,
          quarantined: federationControlDeliveries.quarantined,
        })
        .from(federationControlDeliveries)
        .orderBy(desc(federationControlDeliveries.nextAttemptAt))
        .limit(50),
      deliveries: await db
        .select({
          eventId: federationResultDeliveries.eventId,
          instanceId: federationResultDeliveries.instanceId,
          peerOrigin: federationResultDeliveries.peerOrigin,
          attempts: federationResultDeliveries.attempts,
          nextAttemptAt: federationResultDeliveries.nextAttemptAt,
          receivedAt: federationResultDeliveries.receivedAt,
          appliedAt: federationResultDeliveries.appliedAt,
          errorCode: federationResultDeliveries.errorCode,
          quarantined: federationResultDeliveries.quarantined,
        })
        .from(federationResultDeliveries)
        .orderBy(desc(federationResultDeliveries.nextAttemptAt))
        .limit(50),
      peers: await db.select().from(federationPeers),
      policies: policies.map((row) => row.policy),
      metadata: await db.select().from(federationMetadata),
      jobs: await db
        .select({
          instanceId: federationMetadataJobs.instanceId,
          peerOrigin: federationMetadataJobs.peerOrigin,
          nextAttemptAt: federationMetadataJobs.nextAttemptAt,
          failures: federationMetadataJobs.failures,
          errorCode: federationMetadataJobs.errorCode,
        })
        .from(federationMetadataJobs),
    };
  });
}
export async function manageFederation(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  if (input.operation === 'admission') {
    exact(input, ['operation', 'mode', 'revision']);
    if (input.mode !== 'approved' && input.mode !== 'unblocked')
      throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
    const expected = revision(input.revision);
    return changeD1(db, async (writes) => {
      const { account, organization } = await organizationIdentity(db, subject);
      requireAdministrator(account);
      if (organization.federationRevision !== expected)
        throw new OrganizationError('FEDERATION_CONFLICT', 409);
      writes.push(
        db
          .update(organizations)
          .set({
            externalParticipation: input.mode as 'approved' | 'unblocked',
            federationRevision: expected + 1,
          })
          .where(eq(organizations.id, organization.id)),
      );
      return { ok: true, revision: expected + 1 };
    });
  }
  if (input.operation === 'retryControl') {
    exact(input, ['operation', 'eventId', 'peerOrigin']);
    const eventId = validId(input.eventId),
      peerOrigin = String(input.peerOrigin ?? '');
    return changeD1(db, async (writes) => {
      const { account } = await organizationIdentity(db, subject);
      requireAdministrator(account);
      const key = and(
        eq(federationControlDeliveries.eventId, eventId),
        eq(federationControlDeliveries.peerOrigin, peerOrigin),
      );
      const [job] = await db.select().from(federationControlDeliveries).where(key);
      if (!job || job.appliedAt !== null || job.leaseUntil > Date.now())
        throw new OrganizationError('FEDERATION_TARGET_UNAVAILABLE', 409);
      writes.push(
        db
          .update(federationControlDeliveries)
          .set({ nextAttemptAt: 0, quarantined: false, errorCode: null })
          .where(and(key, isNull(federationControlDeliveries.appliedAt))),
      );
      return { ok: true };
    });
  }
  if (input.operation === 'retryResult') {
    exact(input, ['operation', 'eventId']);
    const eventId = validId(input.eventId);
    return changeD1(db, async (writes) => {
      const { account } = await organizationIdentity(db, subject);
      requireAdministrator(account);
      const [job] = await db
        .select()
        .from(federationResultDeliveries)
        .where(eq(federationResultDeliveries.eventId, eventId));
      if (!job || job.receivedAt !== null || job.leaseUntil > Date.now())
        throw new OrganizationError('FEDERATION_TARGET_UNAVAILABLE', 409);
      writes.push(
        db
          .update(federationResultDeliveries)
          .set({ nextAttemptAt: 0, quarantined: false, errorCode: null })
          .where(
            and(
              eq(federationResultDeliveries.eventId, eventId),
              isNull(federationResultDeliveries.receivedAt),
            ),
          ),
      );
      return { ok: true };
    });
  }
  if (input.operation === 'peer') {
    exact(input, [
      'operation',
      'origin',
      'name',
      'kid',
      'publicKey',
      'approved',
      'discovered',
      'participationBlocked',
      'receiveRanked',
      'receiveCasual',
      'revision',
    ]);
    const peerOrigin = String(input.origin ?? '');
    try {
      peerRequest(peerOrigin, [peerOrigin], INBOX_PATH, 'validation');
    } catch {
      throw new OrganizationError('INVALID_PEER_ORIGIN', 400);
    }
    const name = validName(input.name);
    if (
      typeof input.kid !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(input.kid) ||
      typeof input.publicKey !== 'string' ||
      input.publicKey.length > 2048 ||
      typeof input.approved !== 'boolean'
    )
      throw new OrganizationError('INVALID_PEER_KEY', 400);
    for (const field of ['participationBlocked', 'receiveRanked', 'receiveCasual'])
      if (input[field] !== undefined && typeof input[field] !== 'boolean')
        throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
    let publicKey: string;
    try {
      publicKey = await exportSPKI(await importSPKI(input.publicKey, 'EdDSA'));
    } catch {
      throw new OrganizationError('INVALID_PEER_KEY', 400);
    }
    const expected = revision(input.revision);
    return changeD1(db, async (writes) => {
      const { account } = await organizationIdentity(db, subject);
      requireAdministrator(account);
      const [existing] = await db
        .select()
        .from(federationPeers)
        .where(eq(federationPeers.origin, peerOrigin));
      if ((existing?.revision ?? 0) !== expected)
        throw new OrganizationError('FEDERATION_CONFLICT', 409);
      const [key] = await db
        .select()
        .from(federationPeerKeys)
        .where(
          and(
            eq(federationPeerKeys.origin, peerOrigin),
            eq(federationPeerKeys.kid, String(input.kid)),
          ),
        );
      if (key && key.publicKey !== publicKey)
        throw new OrganizationError('PEER_KEY_CONFLICT', 409);
      writes.push(
        rowsD1(
          federationPeers,
          [
            {
              origin: peerOrigin,
              name,
              kid: String(input.kid),
              publicKey,
              approved: Boolean(input.approved),
              discovered: existing?.discovered ?? false,
              participationBlocked:
                (input.participationBlocked as boolean | undefined) ??
                existing?.participationBlocked ??
                false,
              receiveRanked:
                (input.receiveRanked as boolean | undefined) ??
                existing?.receiveRanked ??
                true,
              receiveCasual:
                (input.receiveCasual as boolean | undefined) ??
                existing?.receiveCasual ??
                true,
              revision: expected + 1,
            },
          ],
          true,
        ),
      );
      if (!key)
        writes.push(
          db.insert(federationPeerKeys).values({
            origin: peerOrigin,
            kid: String(input.kid),
            publicKey,
            createdAt: new Date().toISOString(),
          }),
        );
      return { ok: true, revision: expected + 1 };
    });
  }
  if (input.operation === 'policy') {
    exact(input, ['operation', 'instanceId', 'peerOrigin', 'peerInstanceId']);
    const instanceId = validId(input.instanceId),
      peerInstanceId = validId(input.peerInstanceId);
    return changeD1(db, async (writes) => {
      const { account, organization } = await organizationIdentity(db, subject);
      requireAdministrator(account);
      const [instance] = await db
        .select()
        .from(instances)
        .where(
          and(
            eq(instances.id, instanceId),
            eq(instances.organizationId, organization.id),
          ),
        );
      const [peer] = await db
        .select()
        .from(federationPeers)
        .where(eq(federationPeers.origin, String(input.peerOrigin)));
      if (!instance || instance.state === 'archived' || !peer?.approved)
        throw new OrganizationError('FEDERATION_TARGET_UNAVAILABLE', 409);
      const [existing] = await db
        .select()
        .from(federationPolicies)
        .where(
          and(
            eq(federationPolicies.instanceId, instanceId),
            eq(federationPolicies.peerOrigin, peer.origin),
            eq(federationPolicies.peerInstanceId, peerInstanceId),
          ),
        );
      const [metadata] = await db
        .select()
        .from(federationMetadata)
        .where(
          and(
            eq(federationMetadata.instanceId, instanceId),
            eq(federationMetadata.peerOrigin, peer.origin),
          ),
        );
      if (
        !metadata ||
        metadata.errorCode ||
        metadata.lastSuccessAt < Date.now() - FEDERATION_FRESH_MS ||
        !metadata.payload.instances.some((row) => row.id === peerInstanceId)
      )
        throw new OrganizationError('FEDERATION_METADATA_REQUIRED', 409);
      if (existing) return { ok: true, id: existing.id };
      const id = crypto.randomUUID();
      writes.push(
        db.insert(federationPolicies).values({
          id,
          instanceId,
          peerOrigin: peer.origin,
          peerInstanceId,
          permissions: disabledFederationPermissions(),
        }),
      );
      return { ok: true, id };
    });
  }
  if (input.operation === 'policies' || input.operation === 'previewPolicies') {
    exact(input, ['operation', 'items']);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50)
      throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
    const items = input.items.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
      const row = value as Record<string, unknown>;
      exact(row, ['id', 'revision', 'permissions']);
      let permissions: ReturnType<typeof federationPermissions>;
      try {
        permissions = federationPermissions(row.permissions);
      } catch {
        throw new OrganizationError('INVALID_PERMISSIONS', 400);
      }
      return { id: validId(row.id), revision: revision(row.revision), permissions };
    });
    if (new Set(items.map((row) => row.id)).size !== items.length)
      throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
    const plan = async (writes: Parameters<Parameters<typeof changeD1>[1]>[0]) => {
      const { account, organization } = await organizationIdentity(db, subject);
      requireAdministrator(account);
      const targets = await db
        .select({ policy: federationPolicies })
        .from(federationPolicies)
        .innerJoin(instances, eq(instances.id, federationPolicies.instanceId))
        .where(
          and(
            eq(instances.organizationId, organization.id),
            sql`${federationPolicies.id} in (select value from json_each(${JSON.stringify(items.map((row) => row.id))}))`,
          ),
        );
      const accepted: (typeof federationPolicies.$inferInsert)[] = [];
      const results = items.map((row) => {
        const current = targets.find((target) => target.policy.id === row.id)?.policy;
        if (!current)
          return { id: row.id, ok: false, code: 'FEDERATION_TARGET_UNAVAILABLE' };
        if (current.revision !== row.revision)
          return { id: row.id, ok: false, code: 'FEDERATION_CONFLICT' };
        accepted.push({
          ...current,
          permissions: row.permissions,
          revision: current.revision + 1,
        });
        return {
          id: row.id,
          ok: true,
          before: current.permissions,
          after: row.permissions,
          revision: current.revision + 1,
        };
      });
      if (input.operation === 'policies' && accepted.length)
        writes.push(rowsD1(federationPolicies, accepted, true));
      return { results };
    };
    return input.operation === 'policies'
      ? changeD1(db, plan)
      : readD1(db, () => plan([]));
  }
  throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
}
