import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { API_PATHS } from '../../shared/api-paths.ts';
import type { FederatedResult } from '../../shared/federation-results.ts';
import type { HistoryEntry } from '../../shared/results.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, connectD1, type D1Write, type Database, rowsD1 } from '../db/d1.ts';
import {
  federationDeletedInstances,
  federationParticipations,
  federationReservations,
  federationResultDeliveries,
  federationResultInbox,
  instances,
  organizationAccounts,
  organizations,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError, validId } from '../organization/access.ts';
import { organizationIdentity } from '../organization/database.ts';
import { readResults } from '../results/read.ts';
import type { ResultRecord } from '../results/record.ts';
import { retiredResultActors } from './controls.ts';
import { signEvent, verifyEvent } from './events.ts';
import { federationDatabase, federationEnabled, requestPeer } from './transport.ts';

export async function planResultDeliveries(
  db: Database,
  writes: D1Write[],
  record: ResultRecord,
) {
  if (record.kind === 'development') return;
  const admissions = await db
    .select({
      row: federationReservations,
      instance: instances,
    })
    .from(federationReservations)
    .innerJoin(instances, eq(instances.id, federationReservations.instanceId))
    .where(
      and(
        eq(instances.owner, record.owner),
        record.kind === 'room' && record.parentRoomId
          ? and(
              eq(federationReservations.mode, 'room'),
              eq(federationReservations.roomId, record.parentRoomId),
            )
          : eq(federationReservations.matchId, record.matchId),
        inArray(
          federationReservations.actorId,
          record.players.map((player) => player.id),
        ),
      ),
    );
  const deliveries: (typeof federationResultDeliveries.$inferInsert)[] = [];
  const recipients = new Set<string>();
  for (const { row, instance } of admissions) {
    const recipient = `${row.peerOrigin}:${row.sourceActorId}`;
    if (recipients.has(recipient)) continue;
    recipients.add(recipient);
    const eventId = crypto.randomUUID(),
      payload: FederatedResult = {
        version: 1,
        eventId,
        matchId: record.matchId,
        reservationId: row.id,
        hostInstanceId: instance.id,
        hostInstanceName: instance.name,
        sourceOrganizationId: row.sourceOrganizationId,
        sourceActorId: row.sourceActorId,
        selfId: row.actorId,
        startedAt: record.startedAt,
        finishedAt: record.result.finishedAt,
        kind: record.kind,
        reason: record.result.reason,
        winnerId: record.result.winnerId,
        definition: {
          competition: record.definition.competition,
          rulesHash: record.definition.rulesHash,
          manifestHash: record.definition.manifestHash,
        },
        players: record.players.map(
          ({
            id,
            name,
            correct,
            mistakes,
            ratingDelta,
            disqualified,
            guest,
            role,
            forfeited,
          }) => ({
            id,
            name,
            correct,
            mistakes,
            ratingDelta,
            disqualified,
            ...(guest === undefined ? {} : { guest }),
            ...(role === undefined ? {} : { role }),
            ...(forfeited === undefined ? {} : { forfeited }),
          }),
        ),
      };
    deliveries.push({
      eventId,
      matchId: record.matchId,
      instanceId: instance.id,
      peerOrigin: row.peerOrigin,
      sourceActorId: row.sourceActorId,
      payload,
      payloadHash: await contentHash(payload),
    });
  }
  if (deliveries.length) writes.push(rowsD1(federationResultDeliveries, deliveries));
}
function resultEvent(value: unknown): FederatedResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('INVALID_RESULT_EVENT', 400);
  const result = value as FederatedResult;
  if (
    Object.keys(result).sort().join(',') !==
      'definition,eventId,finishedAt,hostInstanceId,hostInstanceName,kind,matchId,players,reason,reservationId,selfId,sourceActorId,sourceOrganizationId,startedAt,version,winnerId' ||
    result.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(result.sourceActorId) ||
    !/^[a-f0-9]{64}$/.test(result.selfId) ||
    !['ranked', 'casual', 'room'].includes(result.kind) ||
    !Number.isSafeInteger(result.startedAt) ||
    !Number.isSafeInteger(result.finishedAt) ||
    result.finishedAt < result.startedAt ||
    result.finishedAt > Date.now() + 5000 ||
    typeof result.hostInstanceName !== 'string' ||
    result.hostInstanceName.length > 80 ||
    ![
      'target_reached',
      'exhausted',
      'question_limit',
      'last_remaining',
      'connections',
      'disqualifications',
    ].includes(result.reason) ||
    !Array.isArray(result.players) ||
    result.players.length < 1 ||
    result.players.length > 16
  )
    throw new OrganizationError('INVALID_RESULT_EVENT', 400);
  for (const id of [
    result.eventId,
    result.matchId,
    result.reservationId,
    result.hostInstanceId,
    result.sourceOrganizationId,
  ])
    validId(id);
  for (const player of result.players) {
    if (
      !player ||
      Object.keys(player)
        .filter((key) => !['guest', 'role', 'forfeited'].includes(key))
        .sort()
        .join(',') !== 'correct,disqualified,id,mistakes,name,ratingDelta' ||
      (player.guest !== undefined && typeof player.guest !== 'boolean') ||
      (player.role !== undefined &&
        (player.role !== 'presenter' || result.kind !== 'room')) ||
      (player.forfeited !== undefined && typeof player.forfeited !== 'boolean') ||
      typeof player.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(player.id) ||
      typeof player.name !== 'string' ||
      player.name.length > 80 ||
      typeof player.disqualified !== 'boolean' ||
      ![player.correct, player.mistakes, player.ratingDelta].every(
        Number.isSafeInteger,
      ) ||
      player.correct < 0 ||
      player.mistakes < 0 ||
      Math.abs(player.ratingDelta) > 100000
    )
      throw new OrganizationError('INVALID_RESULT_EVENT', 400);
  }
  if (
    new Set(result.players.map((player) => player.id)).size !== result.players.length ||
    !result.players.some((player) => player.id === result.selfId) ||
    (result.winnerId !== null &&
      !result.players.some((player) => player.id === result.winnerId)) ||
    (result.kind !== 'ranked' &&
      result.players.some((player) => player.ratingDelta !== 0)) ||
    !result.definition ||
    !result.definition.competition ||
    Object.keys(result.definition.competition).sort().join(',') !== 'id,owner,version' ||
    typeof result.definition.competition.owner !== 'string' ||
    result.definition.competition.owner.length > 256 ||
    typeof result.definition.competition.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(result.definition.competition.id) ||
    !Number.isSafeInteger(result.definition.competition.version) ||
    result.definition.competition.version < 1 ||
    Object.keys(result.definition).sort().join(',') !==
      'competition,manifestHash,rulesHash' ||
    !/^[a-f0-9]{64}$/.test(result.definition.manifestHash) ||
    !/^[a-f0-9]{64}$/.test(result.definition.rulesHash)
  )
    throw new OrganizationError('INVALID_RESULT_EVENT', 400);
  return result;
}
export async function receiveResultEvent(env: Env, peerOrigin: string, message: unknown) {
  const payload = resultEvent(await verifyEvent(env, peerOrigin, message)),
    hash = await contentHash(payload),
    db = federationDatabase(env);
  const accepted = await changeD1(db, async (writes) => {
    const [previous] = await db
      .select()
      .from(federationResultInbox)
      .where(
        and(
          eq(federationResultInbox.peerOrigin, peerOrigin),
          eq(federationResultInbox.eventId, payload.eventId),
        ),
      );
    if (previous) {
      if (previous.payloadHash !== hash) {
        writes.push(
          db
            .update(federationResultInbox)
            .set({ conflictHash: hash })
            .where(
              and(
                eq(federationResultInbox.peerOrigin, peerOrigin),
                eq(federationResultInbox.eventId, payload.eventId),
              ),
            ),
        );
        return { conflict: true };
      }
      return { received: true, applied: previous.appliedAt !== null, duplicate: true };
    }
    const [organization] = await db.select().from(organizations);
    const [account] = await db
      .select()
      .from(organizationAccounts)
      .where(eq(organizationAccounts.actorId, payload.sourceActorId));
    const [consent] = await db
      .select()
      .from(federationParticipations)
      .where(
        and(
          eq(federationParticipations.peerOrigin, peerOrigin),
          eq(federationParticipations.reservationId, payload.reservationId),
          eq(federationParticipations.actorId, payload.sourceActorId),
          eq(federationParticipations.sourceOrganizationId, payload.sourceOrganizationId),
          eq(federationParticipations.hostInstanceId, payload.hostInstanceId),
          eq(federationParticipations.mode, payload.kind),
          payload.kind === 'room'
            ? undefined
            : eq(federationParticipations.matchId, payload.matchId),
        ),
      );
    if (
      !consent ||
      !organization ||
      payload.sourceOrganizationId !== organization.id ||
      account?.organizationId !== organization.id
    )
      throw new OrganizationError('FEDERATION_RESULT_DENIED', 403);
    writes.push(
      db.insert(federationResultInbox).values({
        peerOrigin,
        eventId: payload.eventId,
        actorId: payload.sourceActorId,
        sourceOrganizationId: payload.sourceOrganizationId,
        payload,
        payloadHash: hash,
        message: String(message),
        receivedAt: Date.now(),
        appliedAt: Date.now(),
        finishedAt: payload.finishedAt,
      }),
    );
    return { received: true, applied: true, duplicate: false };
  });
  if ('conflict' in accepted)
    throw new OrganizationError('FEDERATION_RESULT_CONFLICT', 409);
  return { eventId: payload.eventId, ...accepted };
}
export async function deliverResult(env: Env, eventId: string) {
  const db = federationDatabase(env),
    claimed = await changeD1(db, async (writes) => {
      const [job] = await db
        .select()
        .from(federationResultDeliveries)
        .where(eq(federationResultDeliveries.eventId, eventId));
      if (
        !job ||
        job.receivedAt !== null ||
        job.quarantined ||
        job.nextAttemptAt > Date.now() ||
        job.leaseUntil > Date.now()
      )
        return null;
      writes.push(
        db
          .update(federationResultDeliveries)
          .set({ attempts: job.attempts + 1, leaseUntil: Date.now() + 10000 })
          .where(eq(federationResultDeliveries.eventId, eventId)),
      );
      return { ...job, attempts: job.attempts + 1 };
    });
  if (!claimed) return;
  let errorCode: string | null = null,
    retryAt = 0,
    quarantined = false,
    received = false,
    applied = false;
  try {
    if (claimed.payloadHash !== (await contentHash(claimed.payload)))
      throw new OrganizationError('FEDERATION_RESULT_CONFLICT', 409);
    const message = claimed.message ?? (await signEvent(env, claimed.payload));
    if (!claimed.message)
      await changeD1(db, async (writes) => {
        writes.push(
          db
            .update(federationResultDeliveries)
            .set({ message })
            .where(
              and(
                eq(federationResultDeliveries.eventId, eventId),
                isNull(federationResultDeliveries.message),
              ),
            ),
        );
      });
    const reply = await requestPeer(
      env,
      claimed.peerOrigin,
      API_PATHS.federationInbox,
      'event',
      'event.receipt',
      { event: message },
      100000,
      true,
    );
    const body = reply.body as {
      eventId?: unknown;
      received?: unknown;
      applied?: unknown;
      duplicate?: unknown;
    };
    if (
      !body ||
      Object.keys(body).sort().join(',') !== 'applied,duplicate,eventId,received' ||
      body.eventId !== eventId ||
      body.received !== true ||
      typeof body.applied !== 'boolean' ||
      typeof body.duplicate !== 'boolean'
    )
      throw new OrganizationError('INVALID_RESULT_RECEIPT', 400);
    received = true;
    applied = body.applied;
  } catch (error) {
    errorCode =
      error instanceof OrganizationError ? error.code : 'FEDERATION_RESULT_UNAVAILABLE';
    retryAt = error instanceof OrganizationError ? (error.retryAt ?? 0) : 0;
    quarantined =
      error instanceof OrganizationError &&
      (error.peerStatus === 409 ||
        [400, 401].includes(error.peerStatus ?? error.status) ||
        error.status === 409);
  }
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(federationResultDeliveries)
        .set({
          leaseUntil: 0,
          errorCode,
          quarantined,
          receivedAt: received ? Date.now() : null,
          appliedAt: applied ? Date.now() : null,
          nextAttemptAt: Math.max(
            retryAt,
            Date.now() +
              Math.min(900000, 1000 * 2 ** Math.min(claimed.attempts - 1, 10)) *
                (1 + Math.random() * 0.25),
          ),
        })
        .where(
          and(
            eq(federationResultDeliveries.eventId, eventId),
            eq(federationResultDeliveries.attempts, claimed.attempts),
          ),
        ),
    );
  });
}
export async function foreignHistory(env: Env, subject: string, cursor?: string) {
  if (!env.GAME_D1) throw new OrganizationError('RESULTS_UNAVAILABLE', 503);
  const db = connectD1(env.GAME_D1),
    identity = await organizationIdentity(db, subject);
  let after: { finishedAt: number; eventId: string } | undefined;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !/^\d{13}:[a-f0-9-]{36}$/.test(cursor))
      throw new OrganizationError('INVALID_RESULT_CURSOR', 400);
    const [time, eventId] = cursor.split(':');
    after = { finishedAt: Number(time), eventId: validId(eventId) };
  }
  const rows = await db
    .select()
    .from(federationResultInbox)
    .where(
      and(
        eq(federationResultInbox.actorId, identity.account.actorId),
        sql`${federationResultInbox.appliedAt} is not null`,
        after
          ? sql`(${federationResultInbox.finishedAt},${federationResultInbox.eventId})<(${after.finishedAt},${after.eventId})`
          : undefined,
      ),
    )
    .orderBy(desc(federationResultInbox.finishedAt), desc(federationResultInbox.eventId))
    .limit(21);
  const retired = new Map<string, Set<string>>();
  for (const peer of new Set(rows.map((row) => row.peerOrigin)))
    retired.set(
      peer,
      await retiredResultActors(db, peer, [
        ...new Set(
          rows
            .filter((row) => row.peerOrigin === peer)
            .flatMap((row) => row.payload.players.map((player) => player.id)),
        ),
      ]),
    );
  return {
    history: rows.slice(0, 20).map((row) => ({
      peerOrigin: row.peerOrigin,
      ...row.payload,
      players: row.payload.players.map((player) => ({
        ...player,
        name: retired.get(row.peerOrigin)?.has(player.id)
          ? '退会ユーザー'
          : player.guest && Date.now() >= row.finishedAt + 30 * 86400000
            ? 'ゲスト'
            : player.name,
      })),
    })),
    nextCursor: rows.length > 20 ? `${rows[19].finishedAt}:${rows[19].eventId}` : null,
  };
}
export async function hostResultReview(env: Env, peerOrigin: string, value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'matchId,sourceActorId,sourceOrganizationId'
  )
    throw new OrganizationError('INVALID_RESULT_REVIEW', 400);
  const input = value as {
      matchId: string;
      sourceActorId: string;
      sourceOrganizationId: string;
    },
    db = federationDatabase(env);
  validId(input.matchId);
  validId(input.sourceOrganizationId);
  const [delivery] = await db
    .select()
    .from(federationResultDeliveries)
    .where(
      and(
        eq(federationResultDeliveries.matchId, input.matchId),
        eq(federationResultDeliveries.peerOrigin, peerOrigin),
        eq(federationResultDeliveries.sourceActorId, input.sourceActorId),
        sql`json_extract(${federationResultDeliveries.payload}, '$.sourceOrganizationId')=${input.sourceOrganizationId}`,
      ),
    );
  const [instance] = delivery
    ? await db.select().from(instances).where(eq(instances.id, delivery.instanceId))
    : [];
  if (!delivery || !instance)
    throw new OrganizationError('RESULT_REVIEW_UNAVAILABLE', 404);
  const result = await readResults(db, instance.owner, delivery.payload.selfId, [], {
    section: 'history',
    matchId: input.matchId,
  });
  if (!result.history.length)
    throw new OrganizationError('RESULT_REVIEW_UNAVAILABLE', 404);
  return { questions: result.history[0].questions ?? [] };
}
export async function reviewForeignResult(
  env: Env,
  subject: string,
  peerOrigin: string,
  eventId: string,
): Promise<{ questions: NonNullable<HistoryEntry['questions']> }> {
  const db = federationDatabase(env),
    [row] = await db
      .select()
      .from(federationResultInbox)
      .where(
        and(
          eq(federationResultInbox.peerOrigin, peerOrigin),
          eq(federationResultInbox.eventId, validId(eventId)),
        ),
      );
  if (!row) throw new OrganizationError('RESULT_REVIEW_UNAVAILABLE', 404);
  const [deleted] = await db
    .select()
    .from(federationDeletedInstances)
    .where(
      and(
        eq(federationDeletedInstances.peerOrigin, peerOrigin),
        eq(federationDeletedInstances.instanceId, row.payload.hostInstanceId),
      ),
    );
  if (deleted) throw new OrganizationError('RESULT_REVIEW_UNAVAILABLE', 404);
  const identity = await organizationIdentity(db, subject);
  if (identity.account.actorId !== row.actorId)
    throw new OrganizationError('RESULT_REVIEW_UNAVAILABLE', 404);
  const body = (
    await requestPeer(
      env,
      peerOrigin,
      API_PATHS.federationReview,
      'event',
      'event.receipt',
      {
        matchId: row.payload.matchId,
        sourceActorId: row.actorId,
        sourceOrganizationId: row.sourceOrganizationId,
      },
      100000,
      true,
    )
  ).body;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).join(',') !== 'questions' ||
    !Array.isArray(body.questions) ||
    body.questions.some(
      (question) =>
        !question ||
        typeof question !== 'object' ||
        Array.isArray(question) ||
        Object.keys(question).some(
          (key) =>
            ![
              'id',
              'text',
              'displayAnswer',
              'readings',
              'explanation',
              'source',
              'authorName',
            ].includes(key),
        ) ||
        !['id', 'text', 'displayAnswer', 'explanation', 'source'].every(
          (key) =>
            typeof (question as Record<string, unknown>)[key] === 'string' &&
            String((question as Record<string, unknown>)[key]).length <= 10000,
        ) ||
        (question.authorName !== undefined && typeof question.authorName !== 'string') ||
        !Array.isArray(question.readings) ||
        question.readings.length > 32 ||
        question.readings.some(
          (reading: unknown) => typeof reading !== 'string' || reading.length > 256,
        ),
    )
  )
    throw new OrganizationError('INVALID_RESULT_REVIEW', 503);
  return body as unknown as { questions: NonNullable<HistoryEntry['questions']> };
}
export async function dispatchSavedResult(env: Env, matchId: string) {
  // Deployments without federation never create result deliveries.
  if (!federationEnabled(env)) return;
  const db = federationDatabase(env),
    erasure = env.ACCOUNT_ERASURE;
  if (!erasure) throw new OrganizationError('FEDERATION_NOT_CONFIGURED', 503);
  for (const job of await dueResultDeliveries(db, Date.now(), matchId)) {
    const response = await erasure.fetch('https://account-erasure.internal/maintenance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'federationResult', eventId: job.eventId }),
    });
    await response.json().catch(() => null);
    if (!response.ok) throw new OrganizationError('FEDERATION_RESULT_UNAVAILABLE', 503);
  }
}
export async function dueResultDeliveries(db: Database, now: number, matchId?: string) {
  return db
    .select({ eventId: federationResultDeliveries.eventId })
    .from(federationResultDeliveries)
    .where(
      and(
        isNull(federationResultDeliveries.receivedAt),
        eq(federationResultDeliveries.quarantined, false),
        lte(federationResultDeliveries.nextAttemptAt, now),
        lte(federationResultDeliveries.leaseUntil, now),
        matchId ? eq(federationResultDeliveries.matchId, matchId) : undefined,
      ),
    )
    .orderBy(federationResultDeliveries.nextAttemptAt)
    .limit(2);
}
