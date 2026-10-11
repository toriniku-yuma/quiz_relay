import { and, eq, gt, inArray, ne } from 'drizzle-orm';
import { API_PATHS } from '../../shared/api-paths.ts';
import { normalizeDisplayName } from '../../shared/profile.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, connectD1 } from '../db/d1.ts';
import {
  federationActors,
  federationNonces,
  federationParticipations,
  federationPeers,
  federationReservationClosures,
  federationReservations,
  federationRetiredIdentities,
  federationSessions,
  instances,
  organizationAccounts,
  organizations,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { actorForSubject, OrganizationError, validId } from '../organization/access.ts';
import { allowedInstanceActors } from '../organization/database.ts';
import { ensureCasualCatalog } from '../rooms/database.ts';
import { roomResult } from '../rooms/rpc.ts';
import { participationPolicy } from './admission.ts';
import { participationSource, sourceActors } from './participation-source.ts';
import { canonical, origin } from './signatures.ts';
import { signParticipationTicket, verifyParticipationTicket } from './tickets.ts';
import { federationDatabase, requestPeer } from './transport.ts';

export const participationLifetime = 60000;
type Reservation = typeof federationReservations.$inferSelect;
type ReservationRequest = {
  sourceInstanceId: string;
  hostInstanceId: string;
  mode: 'ranked' | 'casual' | 'room';
  actorId: string;
  displayName: string;
  operationId: string;
  authorizationId: string;
};
export function participationMode(value: unknown): ReservationRequest['mode'] {
  if (value !== 'ranked' && value !== 'casual' && value !== 'room')
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  return value;
}
function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  return value as Record<string, unknown>;
}
function reservationRequest(value: unknown): ReservationRequest {
  const input = object(value);
  if (
    Object.keys(input).sort().join(',') !==
      'actorId,authorizationId,displayName,hostInstanceId,mode,operationId,sourceInstanceId' ||
    typeof input.actorId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.actorId)
  )
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const displayName = normalizeDisplayName(input.displayName);
  if (!displayName || displayName !== input.displayName)
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  return {
    sourceInstanceId: validId(input.sourceInstanceId),
    hostInstanceId: validId(input.hostInstanceId),
    mode: participationMode(input.mode),
    actorId: input.actorId,
    displayName,
    operationId: validId(input.operationId),
    authorizationId: validId(input.authorizationId),
  };
}
export function participationScope(
  instance: { id: string; owner: string },
  mode: ReservationRequest['mode'],
) {
  return {
    id: instance.id,
    owner: instance.owner,
    ...(mode === 'ranked' ? {} : { mode }),
  };
}
export async function reservationAdmission(
  env: Env,
  row: Reservation,
  instance: { id: string; owner: string; organizationId: string },
) {
  if (row.mode === 'room') {
    if (!row.roomId)
      return {
        ok: true as const,
        room: '',
        token: '',
        expires: row.sessionExpiresAt || Date.now() + 43200000,
      };
    return env.MATCHMAKER.getByName(instance.organizationId).resumeRoom(
      row.actorId,
      row.roomId,
      instance.id,
    );
  }
  return env.MATCHMAKER.getByName(instance.organizationId).enter(
    row.actorId,
    '',
    undefined,
    true,
    participationScope(instance, row.mode),
  );
}
async function reservationIdentity(
  env: Env,
  row: Reservation,
  admission: { room: string; token: string },
) {
  if (row.mode === 'room') {
    const view = admission.room
      ? roomResult(
          await env.GAME_ROOM.getByName(`room:${admission.room}`).userRoomView(
            row.actorId,
            admission.token,
          ),
        )
      : null;
    const status = view?.matchRoom
      ? await env.GAME_ROOM.getByName(`1c:${view.matchRoom}`).lobbyStatus()
      : null;
    return { matchId: row.id, phase: status?.phase ?? 'WAITING' };
  }
  return env.GAME_ROOM.getByName(`1c:${admission.room}`).reservationIdentity(
    row.actorId,
    admission.token,
  );
}
export async function authorizeParticipation(env: Env, subject: string, value: unknown) {
  const input = object(value);
  if (
    Object.keys(input).sort().join(',') !==
    'hostInstanceId,mode,operationId,peerOrigin,sourceInstanceId'
  )
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const db = federationDatabase(env),
    sourceInstanceId = validId(input.sourceInstanceId),
    hostInstanceId = validId(input.hostInstanceId),
    peerOrigin = origin(String(input.peerOrigin)),
    mode = participationMode(input.mode),
    operationId = validId(input.operationId),
    identity = await participationSource(db, subject, sourceInstanceId);
  if (!identity.account.displayName) throw new OrganizationError('PROFILE_REQUIRED', 409);
  const check = async () => {
    await participationPolicy(
      db,
      sourceInstanceId,
      peerOrigin,
      hostInstanceId,
      mode,
      'send',
    );
    if (
      !(
        await sourceActors(env, db, sourceInstanceId, mode, [identity.account.actorId])
      ).includes(identity.account.actorId)
    )
      throw new OrganizationError('PARTICIPATION_RESTRICTED', 403);
  };
  const maker = env.MATCHMAKER.getByName(identity.organization.id),
    target = { sourceInstanceId, hostInstanceId, peerOrigin, mode };
  try {
    await check();
  } catch (error) {
    if (
      !(error instanceof OrganizationError) ||
      !['FEDERATION_PARTICIPATION_DENIED', 'PARTICIPATION_RESTRICTED'].includes(
        error.code,
      ) ||
      !(await maker.foreignContinuation(identity.account.actorId, operationId, target))
    )
      throw error;
  }
  const claimed = await maker.claimForeign(
    identity.account.actorId,
    {
      sourceInstanceId,
      hostInstanceId,
      peerOrigin,
      mode,
    },
    operationId,
    identity.account.displayName,
  );
  if (!claimed.ok)
    throw new OrganizationError(claimed.code, claimed.code === 'RATE_LIMIT' ? 429 : 409);
  const response = await requestPeer(
    env,
    peerOrigin,
    API_PATHS.participationReservations,
    'reservation.request',
    'reservation.response',
    {
      sourceInstanceId,
      hostInstanceId,
      mode,
      operationId,
      actorId: identity.account.actorId,
      displayName: claimed.name,
      authorizationId: claimed.authorizationId,
    },
    32768,
    true,
  );
  const result = object(response.body);
  if (
    Object.keys(result).sort().join(',') !==
      'existingStarted,expiresAt,matchId,reservationId,sessionExpiresAt' ||
    typeof result.existingStarted !== 'boolean' ||
    !Number.isSafeInteger(result.expiresAt) ||
    Number(result.expiresAt) <= Date.now() + 5000 ||
    Number(result.expiresAt) > Date.now() + participationLifetime + 5000 ||
    !Number.isSafeInteger(result.sessionExpiresAt) ||
    Number(result.sessionExpiresAt) <= Date.now() ||
    Number(result.sessionExpiresAt) > Date.now() + 43200000 + 5000
  )
    throw new OrganizationError('INVALID_RESERVATION_RESPONSE', 503);
  if (!result.existingStarted) await check();
  const committed = await maker.commitForeign(
    identity.account.actorId,
    operationId,
    validId(result.reservationId),
    Number(result.sessionExpiresAt),
    claimed.authorizationId,
  );
  if (!committed.ok) throw new OrganizationError(committed.code, 409);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .insert(federationParticipations)
        .values({
          peerOrigin,
          reservationId: validId(result.reservationId),
          actorId: identity.account.actorId,
          sourceInstanceId,
          hostInstanceId,
          matchId: validId(result.matchId),
          mode,
          authorizedAt: Date.now(),
        })
        .onConflictDoNothing(),
    );
  });
  const now = Math.floor(Date.now() / 1000);
  return {
    ticket: await signParticipationTicket(env, {
      protocolVersion: 1,
      iss: env.FEDERATION_ORIGIN ?? '',
      sub: identity.account.actorId,
      aud: peerOrigin,
      sourceInstanceId,
      hostInstanceId,
      mode,
      matchId: validId(result.matchId),
      reservationId: validId(result.reservationId),
      authorizationId: claimed.authorizationId,
      jti: crypto.randomUUID(),
      iat: now,
      exp: Math.min(now + 60, Math.floor(Number(result.expiresAt) / 1000)),
    }),
    expiresAt: Number(result.expiresAt),
  };
}

export async function reserveParticipation(env: Env, peerOrigin: string, value: unknown) {
  const input = reservationRequest(value),
    db = federationDatabase(env),
    hash = await contentHash({ ...input, authorizationId: undefined }),
    [organization] = await db.select().from(organizations);
  if (!organization) throw new OrganizationError('SETUP_REQUIRED', 409);
  const actorId = await actorForSubject(
    organization.identityNamespace,
    `federation:${peerOrigin}:${input.actorId}`,
  );
  const [prior] = await db
    .select()
    .from(federationReservations)
    .where(
      and(
        eq(federationReservations.peerOrigin, peerOrigin),
        eq(federationReservations.operationId, input.operationId),
      ),
    );
  let continuation:
    | {
        admission: { ok: true; room: string; token: string; expires: number };
        matchId: string;
      }
    | undefined;
  if (
    prior?.state === 'exchanged' &&
    prior.requestHash === hash &&
    (prior.roomId || prior.mode === 'room') &&
    prior.sessionExpiresAt > Date.now()
  ) {
    const [host] = await db
      .select()
      .from(instances)
      .where(eq(instances.id, prior.instanceId));
    if (host) {
      const admission = await reservationAdmission(env, prior, host);
      if (admission.ok && admission.room === (prior.roomId ?? '')) {
        const actual = await reservationIdentity(env, prior, admission);
        if (actual.matchId === prior.matchId && actual.phase !== 'WAITING')
          continuation = { admission, matchId: actual.matchId };
      }
    }
  }
  const reservation = await changeD1(db, async (writes) => {
    const [retired] = await db
      .select()
      .from(federationRetiredIdentities)
      .where(
        and(
          eq(federationRetiredIdentities.peerOrigin, peerOrigin),
          eq(federationRetiredIdentities.actorId, input.actorId),
        ),
      );
    if (retired) throw new OrganizationError('ACCOUNT_WITHDRAWN', 403);
    const [closed] = await db
      .select()
      .from(federationReservationClosures)
      .where(
        and(
          eq(federationReservationClosures.peerOrigin, peerOrigin),
          eq(federationReservationClosures.operationId, input.operationId),
        ),
      );
    if (closed) throw new OrganizationError('STALE_RESERVATION', 409);
    const [instance] = await db
      .select()
      .from(instances)
      .where(eq(instances.id, input.hostInstanceId));
    if (
      !instance ||
      (!continuation &&
        (instance.state !== 'published' ||
          (input.mode === 'ranked'
            ? instance.rankedPauseReason
            : instance.casualPauseReason ||
              (input.mode === 'casual' && !instance.casualConfig.enabled))))
    )
      throw new OrganizationError('INSTANCE_NOT_AVAILABLE', 403);
    if (!continuation)
      await participationPolicy(
        db,
        instance.id,
        peerOrigin,
        input.sourceInstanceId,
        input.mode,
        'receive',
      );
    const [account] = await db
      .select()
      .from(organizationAccounts)
      .where(eq(organizationAccounts.actorId, actorId));
    if (account?.withdrawnAt) throw new OrganizationError('ACCOUNT_WITHDRAWN', 403);
    const [previous] = await db
      .select()
      .from(federationReservations)
      .where(
        and(
          eq(federationReservations.peerOrigin, peerOrigin),
          eq(federationReservations.operationId, input.operationId),
        ),
      );
    if (previous) {
      if (previous.requestHash !== hash)
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      if (
        previous.state === 'closed' ||
        (previous.state !== 'exchanged' && previous.expiresAt <= Date.now())
      )
        throw new OrganizationError('STALE_RESERVATION', 409);
      writes.push(
        db
          .update(federationReservations)
          .set({
            authorizationId: input.authorizationId,
            allowedUntil: Date.now() + participationLifetime,
          })
          .where(eq(federationReservations.id, previous.id)),
      );
      if (previous.authorizationId !== input.authorizationId)
        writes.push(
          db
            .delete(federationSessions)
            .where(eq(federationSessions.reservationId, previous.id)),
        );
      return {
        reservation: { ...previous, authorizationId: input.authorizationId },
        instance,
      };
    }
    if (!account)
      writes.push(
        db.insert(organizationAccounts).values({
          actorId,
          organizationId: organization.id,
          subject: `federation:${peerOrigin}:${input.actorId}`,
          // Home names may coincide with a local name. The verified name belongs to
          // the admission, never the local profile namespace or administrator role.
        }),
      );
    writes.push(
      db
        .insert(federationActors)
        .values({
          actorId,
          peerOrigin,
          sourceActorId: input.actorId,
          displayName: input.displayName,
        })
        .onConflictDoUpdate({
          target: federationActors.actorId,
          set: { displayName: input.displayName },
        }),
    );
    const reservation: Reservation = {
      id: crypto.randomUUID(),
      peerOrigin,
      operationId: input.operationId,
      requestHash: hash,
      authorizationId: input.authorizationId,
      sourceInstanceId: input.sourceInstanceId,
      sourceActorId: input.actorId,
      actorId,
      instanceId: instance.id,
      mode: input.mode,
      displayName: input.displayName,
      roomId: null,
      matchId: null,
      state: 'creating',
      expiresAt: Date.now() + participationLifetime,
      sessionExpiresAt: 0,
      allowedUntil: Date.now() + participationLifetime,
    };
    writes.push(db.insert(federationReservations).values(reservation));
    return { reservation, instance };
  });
  const row = reservation.reservation,
    instance = reservation.instance;
  if (row.mode === 'room') {
    const admission = await reservationAdmission(env, row, instance);
    if (!admission.ok) throw new OrganizationError(admission.code, 409);
    await changeD1(db, async (writes) => {
      const [current] = await db
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.id, row.id));
      if (!current || current.state === 'closed')
        throw new OrganizationError('STALE_RESERVATION', 409);
      writes.push(
        db
          .update(federationReservations)
          .set({
            state: current.state === 'exchanged' ? 'exchanged' : 'reserved',
            matchId: row.id,
            sessionExpiresAt: admission.expires,
          })
          .where(eq(federationReservations.id, row.id)),
      );
    });
    return {
      reservationId: row.id,
      matchId: row.id,
      expiresAt: Date.now() + participationLifetime,
      sessionExpiresAt: admission.expires,
      existingStarted: !!continuation,
    };
  }
  if (!continuation && input.mode === 'casual')
    await ensureCasualCatalog(env, instance.id);
  const result =
    continuation?.admission ??
    (await env.MATCHMAKER.getByName(organization.id).enter(
      actorId,
      input.displayName,
      undefined,
      row.state === 'exchanged',
      participationScope(instance, input.mode),
      false,
      row.state === 'exchanged' ? undefined : input.operationId,
    ));
  if (!result.ok)
    throw new OrganizationError(
      result.code,
      result.code === 'GAME_DATABASE_UNAVAILABLE'
        ? 503
        : result.code === 'RATE_LIMIT'
          ? 429
          : 409,
    );
  const actual = await env.GAME_ROOM.getByName(`1c:${result.room}`).reservationIdentity(
    actorId,
    result.token,
  );
  if (row.matchId && row.matchId !== actual.matchId)
    throw new OrganizationError('STALE_RESERVATION', 409);
  const expiresAt = Math.min(
    Date.now() + participationLifetime,
    row.state === 'exchanged' ? result.expires : row.expiresAt,
  );
  await changeD1(db, async (writes) => {
    if (!continuation)
      await participationPolicy(
        db,
        instance.id,
        peerOrigin,
        input.sourceInstanceId,
        input.mode,
        'receive',
      );
    const [current] = await db
      .select()
      .from(federationReservations)
      .where(eq(federationReservations.id, row.id));
    if (!current || current.state === 'closed')
      throw new OrganizationError('STALE_RESERVATION', 409);
    writes.push(
      db
        .update(federationReservations)
        .set({
          state: current.state === 'exchanged' ? 'exchanged' : 'reserved',
          roomId: result.room,
          matchId: actual.matchId,
          sessionExpiresAt: result.expires,
        })
        .where(eq(federationReservations.id, row.id)),
    );
  });
  return {
    reservationId: row.id,
    matchId: actual.matchId,
    expiresAt,
    sessionExpiresAt: result.expires,
    existingStarted: !!continuation,
  };
}

// Signed, bounded home check. Only the requesting host's existing policy and
// account IDs are considered; names, email, questions and sanctions never leave.
export async function validateHomeParticipation(
  env: Env,
  peerOrigin: string,
  value: unknown,
) {
  const input = object(value);
  if (
    Object.keys(input).sort().join(',') !==
      'actors,existing,hostInstanceId,mode,sourceInstanceId' ||
    typeof input.existing !== 'boolean' ||
    !Array.isArray(input.actors) ||
    input.actors.length < 1 ||
    input.actors.length > 16 ||
    input.actors.some(
      (actor) =>
        !actor ||
        typeof actor !== 'object' ||
        Array.isArray(actor) ||
        Object.keys(actor).sort().join(',') !== 'actorId,authorizationId,operationId' ||
        typeof actor.actorId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(actor.actorId),
    )
  )
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const db = federationDatabase(env),
    sourceInstanceId = validId(input.sourceInstanceId),
    hostInstanceId = validId(input.hostInstanceId),
    mode = participationMode(input.mode);
  const actors = input.actors.map((actor) => ({
    actorId: String(actor.actorId),
    operationId: validId(actor.operationId),
    authorizationId: validId(actor.authorizationId),
  }));
  const actorIds = actors.map((actor) => actor.actorId);
  if (new Set(actorIds).size !== actors.length)
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const [organization] = await db.select().from(organizations);
  if (!organization) return { actors: [] };
  try {
    if (!input.existing)
      await participationPolicy(
        db,
        sourceInstanceId,
        peerOrigin,
        hostInstanceId,
        mode,
        'send',
      );
  } catch (error) {
    if (
      error instanceof OrganizationError &&
      error.code === 'FEDERATION_PARTICIPATION_DENIED'
    )
      return { actors: [] };
    throw error;
  }
  const allowed = await sourceActors(
    env,
    db,
    sourceInstanceId,
    mode,
    actorIds,
    input.existing,
  );
  const verified: string[] = [];
  for (const actor of actors) {
    if (!allowed.includes(actor.actorId)) continue;
    if (
      await env.MATCHMAKER.getByName(organization.id).foreignAuthorization(
        actor.actorId,
        actor.operationId,
        actor.authorizationId,
        { peerOrigin, sourceInstanceId, hostInstanceId, mode },
      )
    )
      verified.push(actor.actorId);
  }
  return {
    actors: verified,
  };
}

export async function refreshParticipationAccess(
  env: Env,
  instanceId: string,
  actors: string[],
  force = false,
  matchId?: string,
  existing = false,
  roomId?: string,
) {
  if (
    !actors.length ||
    !env.GAME_D1 ||
    !env.FEDERATION_ORIGIN ||
    !env.SIGNING_KID ||
    !env.SIGNING_PRIVATE_KEY
  )
    return;
  const db = connectD1(env.GAME_D1);
  const rows = await db
    .select()
    .from(federationReservations)
    .where(
      and(
        eq(federationReservations.instanceId, instanceId),
        matchId ? eq(federationReservations.matchId, matchId) : undefined,
        roomId
          ? and(
              eq(federationReservations.mode, 'room'),
              eq(federationReservations.roomId, roomId),
            )
          : undefined,
        inArray(federationReservations.actorId, actors),
        ne(federationReservations.state, 'closed'),
        gt(federationReservations.sessionExpiresAt, Date.now()),
      ),
    );
  const groups = new Map<string, Reservation[]>();
  for (const row of rows) {
    if (!force && row.allowedUntil > Date.now() + 10000) continue;
    const key = canonical([
      row.peerOrigin,
      row.sourceInstanceId,
      row.mode,
      roomId ?? row.matchId,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  // Bound fan-out to the game's maximum 16 participants. A failing home closes
  // waiting admission; an already started game does not call this check.
  for (const group of groups.values()) {
    const first = group[0];
    let allowed: string[] = [];
    try {
      const response = await requestPeer(
        env,
        first.peerOrigin,
        API_PATHS.participationValidation,
        'reservation.request',
        'reservation.response',
        {
          sourceInstanceId: first.sourceInstanceId,
          hostInstanceId: instanceId,
          mode: first.mode,
          existing,
          actors: group.map((row) => ({
            actorId: row.sourceActorId,
            operationId: row.operationId,
            authorizationId: row.authorizationId,
          })),
        },
        16384,
        true,
      );
      const result = object(response.body);
      if (
        Object.keys(result).join(',') !== 'actors' ||
        !Array.isArray(result.actors) ||
        result.actors.some((actor) => !group.some((row) => row.sourceActorId === actor))
      )
        throw new OrganizationError('INVALID_PARTICIPATION_RESPONSE', 503);
      allowed = result.actors as string[];
    } catch {
      /* A cached permission cannot bypass a failed home check. */
    }
    await changeD1(db, async (writes) => {
      for (const row of group)
        writes.push(
          db
            .update(federationReservations)
            .set({
              allowedUntil: allowed.includes(row.sourceActorId)
                ? Date.now() + participationLifetime
                : 0,
            })
            .where(
              and(
                eq(federationReservations.id, row.id),
                ne(federationReservations.state, 'closed'),
              ),
            ),
        );
    });
  }
}

export async function exchangeParticipation(env: Env, value: unknown) {
  const input = object(value);
  if (Object.keys(input).join(',') !== 'ticket')
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const ticket = await verifyParticipationTicket(env, input.ticket),
    db = federationDatabase(env);
  const [used] = await db
    .select({ nonce: federationNonces.nonce })
    .from(federationNonces)
    .where(
      and(
        eq(federationNonces.issuer, ticket.iss),
        eq(federationNonces.purpose, 'participation'),
        eq(federationNonces.nonce, ticket.jti),
      ),
    );
  if (used) throw new OrganizationError('PARTICIPATION_TICKET_REPLAY', 409);
  const [reserved] = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.id, ticket.reservationId));
  if (
    !reserved ||
    reserved.peerOrigin !== ticket.iss ||
    reserved.sourceActorId !== ticket.sub ||
    reserved.sourceInstanceId !== ticket.sourceInstanceId ||
    reserved.instanceId !== ticket.hostInstanceId ||
    reserved.mode !== ticket.mode ||
    reserved.matchId !== ticket.matchId ||
    reserved.authorizationId !== ticket.authorizationId ||
    (!reserved.roomId && reserved.mode !== 'room')
  )
    throw new OrganizationError('PARTICIPATION_TICKET_BINDING', 401);
  const [instance] = await db
    .select()
    .from(instances)
    .where(eq(instances.id, reserved.instanceId));
  if (!instance) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
  const admission = await reservationAdmission(env, reserved, instance);
  if (!admission.ok || admission.room !== (reserved.roomId ?? ''))
    throw new OrganizationError('STALE_RESERVATION', 409);
  const actual = await reservationIdentity(env, reserved, admission);
  if (actual.matchId !== ticket.matchId)
    throw new OrganizationError('STALE_RESERVATION', 409);
  await refreshParticipationAccess(
    env,
    instance.id,
    [reserved.actorId],
    true,
    reserved.matchId ?? undefined,
    actual.phase !== 'WAITING',
  );
  const [verifiedHome] = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.id, reserved.id));
  if (!verifiedHome || verifiedHome.allowedUntil <= Date.now())
    throw new OrganizationError('PARTICIPATION_RESTRICTED', 403);
  if (actual.phase === 'WAITING') {
    if (
      !(
        await allowedInstanceActors(env, participationScope(instance, reserved.mode), [
          reserved.actorId,
        ])
      ).includes(reserved.actorId)
    )
      throw new OrganizationError('PARTICIPATION_RESTRICTED', 403);
  }
  const secret = crypto.randomUUID() + crypto.randomUUID(),
    hash = await contentHash(secret);
  const row = await changeD1(db, async (writes) => {
    const [current] = await db
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.id, reserved.id)),
      [peer] = await db
        .select()
        .from(federationPeers)
        .where(eq(federationPeers.origin, ticket.iss)),
      [used] = await db
        .select()
        .from(federationNonces)
        .where(
          and(
            eq(federationNonces.issuer, ticket.iss),
            eq(federationNonces.purpose, 'participation'),
            eq(federationNonces.nonce, ticket.jti),
          ),
        );
    if (used) throw new OrganizationError('PARTICIPATION_TICKET_REPLAY', 409);
    if (
      !peer ||
      peer.revision !== ticket.keyRevision ||
      !current ||
      current.authorizationId !== ticket.authorizationId ||
      current.state === 'closed' ||
      current.sessionExpiresAt <= Date.now() ||
      (current.state !== 'exchanged' && current.expiresAt <= Date.now()) ||
      Date.now() >= (ticket.exp + 5) * 1000
    )
      throw new OrganizationError('STALE_RESERVATION', 409);
    if (actual.phase === 'WAITING') {
      await participationPolicy(
        db,
        instance.id,
        ticket.iss,
        ticket.sourceInstanceId,
        ticket.mode,
        'receive',
      );
      if (current.allowedUntil <= Date.now())
        throw new OrganizationError('PARTICIPATION_RESTRICTED', 403);
    }
    writes.push(
      db.insert(federationNonces).values({
        issuer: ticket.iss,
        purpose: 'participation',
        nonce: ticket.jti,
        expiresAt: ticket.exp + 5,
      }),
      db.insert(federationSessions).values({
        hash,
        reservationId: current.id,
        expiresAt: current.sessionExpiresAt,
      }),
      db
        .update(federationReservations)
        .set({ state: 'exchanged' })
        .where(eq(federationReservations.id, current.id)),
    );
    return current;
  });
  return { secret, row, token: admission.token };
}

export async function participationSession(
  env: Env,
  secret: string,
  reservationId?: string,
) {
  if (!/^[a-f0-9-]{72}$/.test(secret))
    throw new OrganizationError('SESSION_REQUIRED', 401);
  const db = federationDatabase(env);
  const [row] = await db
    .select({ reservation: federationReservations, instance: instances })
    .from(federationSessions)
    .innerJoin(
      federationReservations,
      eq(federationReservations.id, federationSessions.reservationId),
    )
    .innerJoin(instances, eq(instances.id, federationReservations.instanceId))
    .where(
      and(
        eq(federationSessions.hash, await contentHash(secret)),
        reservationId ? eq(federationReservations.id, reservationId) : undefined,
        gt(federationSessions.expiresAt, Date.now()),
        ne(federationReservations.state, 'closed'),
      ),
    );
  if (!row) throw new OrganizationError('SESSION_REQUIRED', 401);
  return row;
}

export async function resumeParticipation(
  env: Env,
  secret: string,
  reservationId?: string,
) {
  const identity = await participationSession(env, secret, reservationId),
    row = identity.reservation,
    result = await reservationAdmission(env, row, identity.instance);
  if (!result.ok || result.room !== (row.roomId ?? ''))
    throw new OrganizationError('STALE_RESERVATION', 409);
  const actual = await reservationIdentity(env, row, result);
  if (actual.matchId !== row.matchId)
    throw new OrganizationError('STALE_RESERVATION', 409);
  return { ...identity, token: result.token };
}
