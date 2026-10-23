import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { API_PATHS } from '../../shared/api-paths.ts';
import type { FederationControl } from '../../shared/federation-controls.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, type D1Write, type Database, rowsD1 } from '../db/d1.ts';
import {
  federationActors,
  federationControlDeliveries,
  federationControlInbox,
  federationDeletedInstances,
  federationLoginSessions,
  federationParticipations,
  federationPeers,
  federationReservations,
  federationResultDeliveries,
  federationResultInbox,
  federationRetiredIdentities,
  federationSessions,
  instanceRooms,
  organizationAccounts,
  roomMembers,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError, validId } from '../organization/access.ts';
import { signEvent, verifyEvent } from './events.ts';
import { federationDatabase, requestPeer } from './transport.ts';

export async function planControlEvent(
  db: Database,
  writes: D1Write[],
  payload: FederationControl,
  excludedPeer?: string,
) {
  const peers = await db.select().from(federationPeers);
  const participations =
    payload.type === 'withdrawal'
      ? await db
          .select({ peerOrigin: federationParticipations.peerOrigin })
          .from(federationParticipations)
          .where(eq(federationParticipations.actorId, payload.subjectId))
      : [];
  const hash = await contentHash(payload);
  const delivered = await db
    .select({ peerOrigin: federationResultDeliveries.peerOrigin })
    .from(federationResultDeliveries)
    .where(
      payload.type === 'instance-deleted'
        ? eq(federationResultDeliveries.instanceId, payload.subjectId)
        : sql`exists(select 1 from json_each(json_extract(${federationResultDeliveries.payload}, '$.players')) where json_extract(value, '$.id')=${payload.subjectId})`,
    );
  const hosted =
    payload.type === 'instance-deleted'
      ? await db
          .select({ peerOrigin: federationReservations.peerOrigin })
          .from(federationReservations)
          .where(eq(federationReservations.instanceId, payload.subjectId))
      : [];
  const rows = peers
    .filter(
      (peer) =>
        peer.origin !== excludedPeer &&
        (!peer.discovered ||
          delivered.some((row) => row.peerOrigin === peer.origin) ||
          hosted.some((row) => row.peerOrigin === peer.origin) ||
          participations.some((row) => row.peerOrigin === peer.origin)),
    )
    .map((peer) => ({
      eventId: payload.eventId,
      peerOrigin: peer.origin,
      payload,
      payloadHash: hash,
    }));
  if (rows.length) writes.push(rowsD1(federationControlDeliveries, rows, 'ignore'));
}
function controlEvent(value: unknown): FederationControl {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('INVALID_CONTROL_EVENT', 400);
  const payload = value as FederationControl;
  if (
    Object.keys(payload).sort().join(',') !==
      'createdAt,eventId,subjectId,type,version' ||
    payload.version !== 1 ||
    !['withdrawal', 'instance-deleted'].includes(payload.type) ||
    !Number.isSafeInteger(payload.createdAt) ||
    payload.createdAt < 0 ||
    payload.createdAt > Date.now() + 5000
  )
    throw new OrganizationError('INVALID_CONTROL_EVENT', 400);
  validId(payload.eventId);
  if (payload.type === 'withdrawal') {
    if (
      typeof payload.subjectId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.subjectId)
    )
      throw new OrganizationError('INVALID_CONTROL_EVENT', 400);
  } else validId(payload.subjectId);
  return payload;
}
export async function receiveControlEvent(
  env: Env,
  peerOrigin: string,
  message: unknown,
) {
  const payload = controlEvent(await verifyEvent(env, peerOrigin, message)),
    hash = await contentHash(payload),
    db = federationDatabase(env);
  const key = and(
    eq(federationControlInbox.peerOrigin, peerOrigin),
    eq(federationControlInbox.eventId, payload.eventId),
  );
  let forwardedEventId: string | undefined;
  const receipt = await changeD1(db, async (writes) => {
    const [previous] = await db.select().from(federationControlInbox).where(key);
    if (previous) {
      if (previous.payloadHash !== hash) {
        writes.push(
          db.update(federationControlInbox).set({ conflictHash: hash }).where(key),
        );
        return { conflict: true };
      }
      return { received: true, applied: previous.appliedAt !== null, duplicate: true };
    }
    const [peer] = await db
      .select()
      .from(federationPeers)
      .where(eq(federationPeers.origin, peerOrigin));
    if (!peer?.approved) {
      const related =
        payload.type === 'instance-deleted'
          ? await db
              .select({ id: federationParticipations.reservationId })
              .from(federationParticipations)
              .where(
                and(
                  eq(federationParticipations.peerOrigin, peerOrigin),
                  eq(federationParticipations.hostInstanceId, payload.subjectId),
                ),
              )
              .limit(1)
          : await db
              .select({ id: federationResultInbox.eventId })
              .from(federationResultInbox)
              .where(
                and(
                  eq(federationResultInbox.peerOrigin, peerOrigin),
                  sql`exists(select 1 from json_each(json_extract(${federationResultInbox.payload}, '$.players')) where json_extract(value, '$.id')=${payload.subjectId})`,
                ),
              )
              .limit(1);
      const hosted =
        related.length || payload.type !== 'withdrawal'
          ? []
          : await db
              .select({ id: federationActors.actorId })
              .from(federationActors)
              .where(
                and(
                  eq(federationActors.peerOrigin, peerOrigin),
                  eq(federationActors.sourceActorId, payload.subjectId),
                ),
              )
              .limit(1);
      if (!related.length && !hosted.length)
        throw new OrganizationError('FEDERATION_CONTROL_DENIED', 403);
    }
    let applied = payload.type === 'instance-deleted';
    if (payload.type === 'instance-deleted') {
      writes.push(
        db
          .insert(federationDeletedInstances)
          .values({
            peerOrigin,
            instanceId: payload.subjectId,
            deletedAt: payload.createdAt,
          })
          .onConflictDoNothing(),
      );
    } else {
      writes.push(
        db
          .delete(federationLoginSessions)
          .where(
            and(
              eq(federationLoginSessions.peerOrigin, peerOrigin),
              eq(federationLoginSessions.sourceActorId, payload.subjectId),
            ),
          ),
        db
          .insert(federationRetiredIdentities)
          .values({
            peerOrigin,
            actorId: payload.subjectId,
            retiredAt: payload.createdAt,
          })
          .onConflictDoNothing(),
      );
      const [actor] = await db
        .select()
        .from(federationActors)
        .where(
          and(
            eq(federationActors.peerOrigin, peerOrigin),
            eq(federationActors.sourceActorId, payload.subjectId),
          ),
        );
      applied = !actor;
      if (actor) {
        const retiredAt = new Date(payload.createdAt).toISOString();
        writes.push(
          db.delete(roomMembers).where(eq(roomMembers.actorId, actor.actorId)),
          db
            .update(instanceRooms)
            .set({ original: [] })
            .where(eq(instanceRooms.sourceOwner, actor.actorId)),
          db
            .update(organizationAccounts)
            .set({ displayName: null, withdrawnAt: retiredAt, administrator: false })
            .where(eq(organizationAccounts.actorId, actor.actorId)),
          db
            .update(federationActors)
            .set({ displayName: null })
            .where(eq(federationActors.actorId, actor.actorId)),
          db
            .delete(federationSessions)
            .where(
              sql`${federationSessions.reservationId} in (select ${federationReservations.id} from ${federationReservations} where ${federationReservations.actorId}=${actor.actorId})`,
            ),
          sql`insert into quiz_game_result_privacy_jobs (match_id,due_at) select match_id,${retiredAt} from quiz_game_result_players where actor_id=${actor.actorId} on conflict(match_id) do update set due_at=min(due_at,excluded.due_at)`,
        );
        forwardedEventId = crypto.randomUUID();
        await planControlEvent(
          db,
          writes,
          { ...payload, eventId: forwardedEventId, subjectId: actor.actorId },
          peerOrigin,
        );
      }
    }
    writes.push(
      db.insert(federationControlInbox).values({
        peerOrigin,
        eventId: payload.eventId,
        payload,
        payloadHash: hash,
        message: String(message),
        receivedAt: Date.now(),
        appliedAt: applied ? Date.now() : null,
      }),
    );
    return { received: true, applied, duplicate: false };
  });
  if ('conflict' in receipt)
    throw new OrganizationError('FEDERATION_EVENT_CONFLICT', 409);
  if (forwardedEventId) {
    if (!env.ACCOUNT_ERASURE) throw new OrganizationError('ERASURE_UNAVAILABLE', 503);
    const response = await env.ACCOUNT_ERASURE.fetch(
      'https://account-erasure.internal/maintenance',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'federationControls', eventId: forwardedEventId }),
      },
    );
    await response.arrayBuffer();
    // The durable outbox retains failures for the hourly retry.
    if (!response.ok)
      console.error(
        JSON.stringify({ event: 'control_forward_pending', status: response.status }),
      );
  }
  return { eventId: payload.eventId, ...receipt };
}
export async function applyControlEvent(env: Env, peerOrigin: string, eventId: string) {
  const db = federationDatabase(env),
    key = and(
      eq(federationControlInbox.peerOrigin, peerOrigin),
      eq(federationControlInbox.eventId, eventId),
    );
  const [job] = await db.select().from(federationControlInbox).where(key);
  if (!job || job.appliedAt !== null) return;
  await changeD1(db, async (writes) => {
    writes.push(
      db.update(federationControlInbox).set({ appliedAt: Date.now() }).where(key),
    );
  });
}
export async function deliverControlEvent(env: Env, peerOrigin: string, eventId: string) {
  const db = federationDatabase(env),
    key = and(
      eq(federationControlDeliveries.peerOrigin, peerOrigin),
      eq(federationControlDeliveries.eventId, eventId),
    );
  const claimed = await changeD1(db, async (writes) => {
    const [job] = await db.select().from(federationControlDeliveries).where(key);
    if (
      !job ||
      job.appliedAt !== null ||
      job.quarantined ||
      job.leaseUntil > Date.now() ||
      job.nextAttemptAt > Date.now()
    )
      return null;
    writes.push(
      db
        .update(federationControlDeliveries)
        .set({ attempts: job.attempts + 1, leaseUntil: Date.now() + 10000 })
        .where(key),
    );
    return { ...job, attempts: job.attempts + 1 };
  });
  if (!claimed) return;
  let errorCode: string | null = null,
    quarantined = false,
    retryAt = 0,
    received = false,
    applied = false;
  try {
    if ((await contentHash(claimed.payload)) !== claimed.payloadHash)
      throw new OrganizationError('FEDERATION_EVENT_CONFLICT', 409);
    const message = claimed.message ?? (await signEvent(env, claimed.payload));
    if (!claimed.message)
      await changeD1(db, async (writes) => {
        writes.push(
          db
            .update(federationControlDeliveries)
            .set({ message })
            .where(and(key, isNull(federationControlDeliveries.message))),
        );
      });
    const response = await requestPeer(
        env,
        peerOrigin,
        API_PATHS.federationInbox,
        'event',
        'event.receipt',
        { event: message },
        100000,
        true,
      ),
      receipt = response.body as {
        eventId?: unknown;
        received?: unknown;
        applied?: unknown;
        duplicate?: unknown;
      };
    if (
      !receipt ||
      Object.keys(receipt).sort().join(',') !== 'applied,duplicate,eventId,received' ||
      receipt.eventId !== eventId ||
      receipt.received !== true ||
      typeof receipt.applied !== 'boolean' ||
      typeof receipt.duplicate !== 'boolean'
    )
      throw new OrganizationError('INVALID_RESULT_RECEIPT', 400);
    received = true;
    applied = receipt.applied;
  } catch (error) {
    errorCode =
      error instanceof OrganizationError ? error.code : 'FEDERATION_EVENT_UNAVAILABLE';
    retryAt = error instanceof OrganizationError ? (error.retryAt ?? 0) : 0;
    quarantined =
      error instanceof OrganizationError &&
      [400, 401, 409].includes(error.peerStatus ?? error.status);
  }
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(federationControlDeliveries)
        .set({
          leaseUntil: 0,
          errorCode,
          quarantined,
          receivedAt: received ? (claimed.receivedAt ?? Date.now()) : claimed.receivedAt,
          appliedAt: applied ? Date.now() : null,
          nextAttemptAt: Math.max(
            retryAt,
            Date.now() +
              Math.min(900000, 1000 * 2 ** Math.min(claimed.attempts - 1, 10)) *
                (1 + Math.random() * 0.25),
          ),
        })
        .where(and(key, eq(federationControlDeliveries.attempts, claimed.attempts))),
    );
  });
}
export async function dueControlEvents(db: Database, now: number) {
  return db
    .select({
      eventId: federationControlDeliveries.eventId,
      peerOrigin: federationControlDeliveries.peerOrigin,
    })
    .from(federationControlDeliveries)
    .where(
      and(
        isNull(federationControlDeliveries.appliedAt),
        eq(federationControlDeliveries.quarantined, false),
        lte(federationControlDeliveries.nextAttemptAt, now),
        lte(federationControlDeliveries.leaseUntil, now),
      ),
    )
    .orderBy(federationControlDeliveries.nextAttemptAt)
    .limit(2);
}
export async function pendingControlEvents(db: Database) {
  return db
    .select({
      eventId: federationControlInbox.eventId,
      peerOrigin: federationControlInbox.peerOrigin,
    })
    .from(federationControlInbox)
    .where(isNull(federationControlInbox.appliedAt))
    .orderBy(federationControlInbox.receivedAt)
    .limit(1);
}
export async function retiredResultActors(
  db: Database,
  peerOrigin: string,
  actors: string[],
) {
  if (!actors.length) return new Set<string>();
  const rows = await db
    .select({ id: federationRetiredIdentities.actorId })
    .from(federationRetiredIdentities)
    .where(
      and(
        eq(federationRetiredIdentities.peerOrigin, peerOrigin),
        sql`${federationRetiredIdentities.actorId} in (select value from json_each(${JSON.stringify(actors)}))`,
      ),
    );
  return new Set(rows.map((row) => row.id));
}
