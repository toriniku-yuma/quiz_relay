import { and, eq, lte, ne, or, sql } from 'drizzle-orm';
import { API_PATHS } from '../../shared/api-paths.ts';
import { changeD1 } from '../db/d1.ts';
import {
  federationLoginSessions,
  federationReservationClosures,
  federationReservations,
  federationSessions,
  organizations,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { actorForSubject, OrganizationError, validId } from '../organization/access.ts';
import { federationDatabase, requestPeer } from './transport.ts';

export type ForeignEntry = {
  operationId: string;
  requestHash: string;
  peerOrigin: string;
  sourceInstanceId: string;
  hostInstanceId: string;
  mode: 'ranked' | 'casual' | 'room';
  name: string;
  createdAt: number;
  expiresAt: number;
  state: 'reserving' | 'active' | 'releasing';
  successor?: string;
  reservationId?: string;
  authorizationId: string;
  authenticated: boolean;
  logoutPending?: boolean;
};
export async function expireHostParticipations(env: Env, now = Date.now()) {
  const db = federationDatabase(env);
  const pending = await db
    .select()
    .from(federationReservationClosures)
    .where(eq(federationReservationClosures.confirmed, false))
    .orderBy(federationReservationClosures.expiresAt)
    .limit(2);
  const due = await db
    .select()
    .from(federationReservations)
    .where(
      and(
        ne(federationReservations.state, 'closed'),
        or(
          and(
            eq(federationReservations.state, 'exchanged'),
            lte(federationReservations.sessionExpiresAt, now),
          ),
          and(
            ne(federationReservations.state, 'exchanged'),
            lte(federationReservations.expiresAt, now),
          ),
        ),
      ),
    )
    .orderBy(federationReservations.expiresAt, federationReservations.id)
    .limit(2);
  let failed = false;
  for (const row of [
    ...pending,
    ...due.filter(
      (row) =>
        !pending.some(
          (closure) =>
            closure.peerOrigin === row.peerOrigin &&
            closure.operationId === row.operationId,
        ),
    ),
  ].slice(0, 2))
    try {
      await releaseHostParticipation(env, row.peerOrigin, {
        operationId: row.operationId,
        sourceActorId: row.sourceActorId,
      });
    } catch {
      failed = true;
    }
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .delete(federationLoginSessions)
        .where(
          sql`${federationLoginSessions.hash} in (select ${federationLoginSessions.hash} from ${federationLoginSessions} where ${federationLoginSessions.expiresAt}<=${now} order by ${federationLoginSessions.expiresAt} limit 100)`,
        ),
      db
        .delete(federationSessions)
        .where(
          sql`${federationSessions.hash} in (select ${federationSessions.hash} from ${federationSessions} where ${federationSessions.expiresAt}<=${now} order by ${federationSessions.expiresAt} limit 100)`,
        ),
    );
    // Closure receipts remain alongside reservation originals. Removing them could
    // let an old operation allocate another room after its original has closed.
  });
  if (failed) throw new OrganizationError('PARTICIPATION_RELEASE_PENDING', 503);
}
function inputOperation(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !== 'operationId,sourceActorId' ||
    typeof input.sourceActorId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.sourceActorId)
  )
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  return { operationId: validId(input.operationId), sourceActorId: input.sourceActorId };
}
export async function releaseHostParticipation(
  env: Env,
  peerOrigin: string,
  value: unknown,
) {
  const input = inputOperation(value),
    db = federationDatabase(env),
    [organization] = await db.select().from(organizations);
  if (!organization) throw new OrganizationError('SETUP_REQUIRED', 409);
  const actorId = await actorForSubject(
    organization.identityNamespace,
    `federation:${peerOrigin}:${input.sourceActorId}`,
  );
  const saved = await changeD1(db, async (writes) => {
    const [closed] = await db
        .select()
        .from(federationReservationClosures)
        .where(
          and(
            eq(federationReservationClosures.peerOrigin, peerOrigin),
            eq(federationReservationClosures.operationId, input.operationId),
          ),
        ),
      [reservation] = await db
        .select()
        .from(federationReservations)
        .where(
          and(
            eq(federationReservations.peerOrigin, peerOrigin),
            eq(federationReservations.operationId, input.operationId),
          ),
        );
    if (
      (closed && closed.sourceActorId !== input.sourceActorId) ||
      (reservation && reservation.sourceActorId !== input.sourceActorId)
    )
      throw new OrganizationError('PARTICIPATION_BINDING', 403);
    if (!closed)
      writes.push(
        db.insert(federationReservationClosures).values({
          peerOrigin,
          operationId: input.operationId,
          sourceActorId: input.sourceActorId,
          expiresAt: Date.now() + 43200000,
        }),
      );
    if (reservation)
      writes.push(
        db
          .update(federationReservations)
          .set({ state: 'closed', allowedUntil: 0 })
          .where(eq(federationReservations.id, reservation.id)),
      );
    return { closed, reservation };
  });
  if (saved.closed?.confirmed) return { ok: true };
  const maker = env.MATCHMAKER.getByName(organization.id),
    row = saved.reservation;
  if (row?.roomId) {
    const result = await maker.cancel(actorId, row.roomId, true, row.instanceId, true);
    if (!result.ok && result.code !== 'STALE_ROOM')
      throw new OrganizationError('PARTICIPATION_RELEASE_PENDING', 503);
    // STALE_ROOM means a newer allocation is current. Close only this operation;
    // cancelAdmission is bound to its saved generation and cannot evict the new one.
  }
  const result = await maker.cancelAdmission(
    actorId,
    input.operationId,
    row?.instanceId,
    row?.mode === 'ranked' ? undefined : row?.mode,
  );
  if (!result.ok) throw new OrganizationError('PARTICIPATION_RELEASE_PENDING', 503);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(federationReservationClosures)
        .set({ confirmed: true })
        .where(
          and(
            eq(federationReservationClosures.peerOrigin, peerOrigin),
            eq(federationReservationClosures.operationId, input.operationId),
          ),
        ),
    );
  });
  return { ok: true };
}
export async function hostParticipationStatus(
  env: Env,
  peerOrigin: string,
  value: unknown,
) {
  const input = inputOperation(value),
    db = federationDatabase(env);
  const [row] = await db
    .select()
    .from(federationReservations)
    .where(
      and(
        eq(federationReservations.peerOrigin, peerOrigin),
        eq(federationReservations.operationId, input.operationId),
      ),
    );
  if (!row) return { active: false, phase: null };
  if (row.sourceActorId !== input.sourceActorId)
    throw new OrganizationError('PARTICIPATION_BINDING', 403);
  if (row.state === 'creating' && row.expiresAt > Date.now())
    return { active: true, phase: 'WAITING' };
  if (row.state === 'closed' || row.sessionExpiresAt <= Date.now()) {
    await releaseHostParticipation(env, peerOrigin, input);
    return { active: false, phase: null };
  }
  if (!row.roomId) return { active: true, phase: 'WAITING' };
  const status = await env.GAME_ROOM.getByName(
    `${row.mode === 'room' ? 'room' : '1c'}:${row.roomId}`,
  ).lobbyStatus();
  // Completion frees the home participation slot without revoking the host's
  // final result screen or its review session while the player is reading it.
  if (status && ['FINISHED', 'INVALID'].includes(status.phase))
    return { active: false, phase: status.phase };
  if (!status?.actors.includes(row.actorId) || status.closed) {
    await releaseHostParticipation(env, peerOrigin, input);
    return { active: false, phase: status?.phase ?? null };
  }
  return { active: true, phase: status.phase };
}
export async function releaseForeignEntry(
  env: Env,
  actorId: string,
  entry: ForeignEntry,
) {
  const response = await requestPeer(
    env,
    entry.peerOrigin,
    API_PATHS.participationRelease,
    'reservation.request',
    'reservation.response',
    { operationId: entry.operationId, sourceActorId: actorId },
    16384,
    true,
  );
  if (
    !response.body ||
    typeof response.body !== 'object' ||
    Array.isArray(response.body) ||
    Object.keys(response.body).join(',') !== 'ok' ||
    response.body.ok !== true
  )
    throw new OrganizationError('PARTICIPATION_RELEASE_PENDING', 503);
}
export async function foreignEntryStatus(env: Env, actorId: string, entry: ForeignEntry) {
  const response = await requestPeer(
    env,
    entry.peerOrigin,
    API_PATHS.participationStatus,
    'reservation.request',
    'reservation.response',
    { operationId: entry.operationId, sourceActorId: actorId },
    16384,
    true,
  );
  if (
    !response.body ||
    typeof response.body !== 'object' ||
    Array.isArray(response.body) ||
    Object.keys(response.body).sort().join(',') !== 'active,phase' ||
    typeof response.body.active !== 'boolean' ||
    (response.body.phase !== null &&
      !['WAITING', 'REVEALING', 'ANSWERING', 'JUDGED', 'FINISHED', 'INVALID'].includes(
        String(response.body.phase),
      ))
  )
    throw new OrganizationError('INVALID_PARTICIPATION_RESPONSE', 503);
  return { active: response.body.active, phase: response.body.phase as string | null };
}

export async function logoutHostParticipation(
  env: Env,
  peerOrigin: string,
  value: unknown,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'authorizationId,operationId,sourceActorId')
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const authorizationId = validId(input.authorizationId),
    operation = inputOperation({
      operationId: input.operationId,
      sourceActorId: input.sourceActorId,
    }),
    db = federationDatabase(env);
  const [row] = await db
    .select()
    .from(federationReservations)
    .where(
      and(
        eq(federationReservations.peerOrigin, peerOrigin),
        eq(federationReservations.operationId, operation.operationId),
      ),
    );
  if (!row) return { ok: true };
  if (row.sourceActorId !== operation.sourceActorId)
    throw new OrganizationError('PARTICIPATION_BINDING', 403);
  if (row.authorizationId !== authorizationId) return { ok: true };
  await changeD1(db, async (writes) => {
    writes.push(
      db.delete(federationSessions).where(eq(federationSessions.reservationId, row.id)),
      db
        .update(federationReservations)
        .set({ allowedUntil: 0 })
        .where(eq(federationReservations.id, row.id)),
    );
  });
  const [organization] = await db.select().from(organizations);
  if (row.roomId && organization) {
    const result = await env.MATCHMAKER.getByName(organization.id).cancel(
      row.actorId,
      row.roomId,
      true,
      row.instanceId,
      false,
    );
    if (!result.ok && result.code !== 'STALE_ROOM')
      throw new OrganizationError('PARTICIPATION_LOGOUT_PENDING', 503);
  }
  return { ok: true };
}
export async function logoutForeignEntry(env: Env, actorId: string, entry: ForeignEntry) {
  const response = await requestPeer(
    env,
    entry.peerOrigin,
    API_PATHS.participationLogout,
    'reservation.request',
    'reservation.response',
    {
      operationId: entry.operationId,
      sourceActorId: actorId,
      authorizationId: entry.authorizationId,
    },
    16384,
    true,
  );
  if (
    !response.body ||
    typeof response.body !== 'object' ||
    Array.isArray(response.body) ||
    Object.keys(response.body).join(',') !== 'ok' ||
    response.body.ok !== true
  )
    throw new OrganizationError('PARTICIPATION_LOGOUT_PENDING', 503);
}
