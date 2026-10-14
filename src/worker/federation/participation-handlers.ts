import { and, eq } from 'drizzle-orm';
import type { Handler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { API_PATHS } from '../../shared/api-paths.ts';
import type { AuthEnv } from '../auth/handlers.ts';
import { loadMatchDefinition } from '../catalog/database.ts';
import { changeD1 } from '../db/d1.ts';
import {
  federationPeers,
  federationReservations,
  instances,
  organizations,
} from '../db/schema.ts';
import { matchRoomName, userRoomName } from '../game/room-names.ts';
import { OrganizationError, validId } from '../organization/access.ts';
import { roomResult } from '../rooms/rpc.ts';
import { receivingParticipation } from './admission.ts';
import {
  authorizeForeignLogin,
  exchangeForeignLogin,
  foreignLoginSession,
  logoutForeignAccount,
  logoutForeignLogin,
  publicForeignAccount,
} from './login.ts';
import {
  authorizeParticipation,
  exchangeParticipation,
  participationSession,
  reserveParticipation,
  resumeParticipation,
  validateHomeParticipation,
} from './participation.ts';
import {
  hostParticipationStatus,
  logoutHostParticipation,
  releaseHostParticipation,
} from './slots.ts';
import { verifyParticipationTicket } from './tickets.ts';
import { federationDatabase, receiveDelivery, signedDelivery } from './transport.ts';

export const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'Strict' as const,
  path: '/api/v1/participation',
};
export const reservationId = (context: Parameters<Handler<AuthEnv>>[0]) =>
  validId(context.req.query('reservation'));
function setSession(
  context: Parameters<Handler<AuthEnv>>[0],
  id: string,
  secret: string,
  expiresAt: number,
) {
  setCookie(context, `qr_fed_${id}`, secret, {
    ...cookieOptions,
    maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  });
}
export const secretFor = (context: Parameters<Handler<AuthEnv>>[0]) =>
  getCookie(context, `qr_fed_${reservationId(context)}`) ?? '';
function publicSession(row: Awaited<ReturnType<typeof participationSession>>) {
  return {
    reservationId: row.reservation.id,
    operationId: row.reservation.operationId,
    sourceOrganizationId: row.reservation.sourceOrganizationId,
    actorId: row.reservation.actorId,
    sourceActorId: row.reservation.sourceActorId,
    name: row.reservation.displayName,
    instanceId: row.instance.id,
    instanceName: row.instance.name,
    homeOrigin: row.reservation.peerOrigin,
    mode: row.reservation.mode,
    room: row.reservation.roomId ?? '',
    expiresAt: row.reservation.sessionExpiresAt,
  };
}
export const participationTickets: Handler<AuthEnv> = async (context) => {
  context.header('Cache-Control', 'no-store');
  return context.json(
    await authorizeParticipation(
      context.env,
      context.get('subject'),
      await context.req.json().catch(() => null),
    ),
  );
};
export const foreignLoginTickets: Handler<AuthEnv> = async (context) =>
  context.json(
    await authorizeForeignLogin(
      context.env,
      context.get('subject'),
      await context.req.json().catch(() => null),
    ),
  );
export const foreignLoginExchange: Handler<AuthEnv> = async (context) => {
  const result = await exchangeForeignLogin(
    context.env,
    await context.req.json().catch(() => null),
  );
  setCookie(context, 'qr_foreign_login', result.secret, {
    ...cookieOptions,
    maxAge: Math.floor((result.row.expiresAt - Date.now()) / 1000),
  });
  return context.json({ account: publicForeignAccount(result.row) });
};
export const foreignLoginView: Handler<AuthEnv> = async (context) => {
  const row = await foreignLoginSession(
      context.env,
      getCookie(context, 'qr_foreign_login') ?? '',
    ),
    db = federationDatabase(context.env);
  const [[organization], [peer]] = await db.batch([
    db.select().from(organizations).limit(1),
    db.select().from(federationPeers).where(eq(federationPeers.origin, row.peerOrigin)),
  ]);
  if (!organization) throw new OrganizationError('SETUP_REQUIRED', 409);
  const published = await db
    .select()
    .from(instances)
    .where(eq(instances.state, 'published'));
  return context.json({
    account: publicForeignAccount(row),
    organizationName: organization.name,
    instances: published.map((instance) => ({
      id: instance.id,
      name: instance.name,
      ranked:
        !instance.rankedPauseReason &&
        receivingParticipation(organization, peer, 'ranked'),
      casual:
        !instance.casualPauseReason &&
        instance.casualConfig.enabled &&
        receivingParticipation(organization, peer, 'casual'),
      room:
        !instance.casualPauseReason && receivingParticipation(organization, peer, 'room'),
    })),
  });
};
export const foreignLoginLogout: Handler<AuthEnv> = async (context) => {
  const secret = getCookie(context, 'qr_foreign_login');
  let ids: string[] = [];
  if (secret) {
    try {
      ids = await logoutForeignLogin(context.env, secret);
    } catch (error) {
      if (!(error instanceof OrganizationError) || error.code !== 'SESSION_REQUIRED')
        throw error;
    }
  }
  if (context.req.query('reservation')) {
    try {
      const identity = await participationSession(
        context.env,
        secretFor(context),
        reservationId(context),
      );
      ids.push(
        ...(await logoutForeignAccount(
          context.env,
          identity.reservation.peerOrigin,
          identity.reservation.sourceActorId,
        )),
      );
    } catch (error) {
      if (!(error instanceof OrganizationError) || error.code !== 'SESSION_REQUIRED')
        throw error;
    }
  }
  for (const id of ids) deleteCookie(context, `qr_fed_${id}`, cookieOptions);
  deleteCookie(context, 'qr_foreign_login', cookieOptions);
  return context.json({ ok: true });
};
export const participationReservations: Handler<AuthEnv> = async (context) => {
  const delivery = await receiveDelivery(
      context.req.raw,
      context.env,
      'reservation.request',
      32768,
    ),
    body = await reserveParticipation(context.env, delivery.issuer, delivery.body);
  return context.json({
    message: await signedDelivery(
      context.env,
      delivery.issuer,
      API_PATHS.participationReservations,
      'reservation.response',
      body,
      { replyTo: delivery.nonce },
    ),
  });
};
export const participationValidation: Handler<AuthEnv> = async (context) => {
  const delivery = await receiveDelivery(
      context.req.raw,
      context.env,
      'reservation.request',
      16384,
    ),
    body = await validateHomeParticipation(context.env, delivery.issuer, delivery.body);
  return context.json({
    message: await signedDelivery(
      context.env,
      delivery.issuer,
      API_PATHS.participationValidation,
      'reservation.response',
      body,
      { replyTo: delivery.nonce },
    ),
  });
};
export const participationRelease: Handler<AuthEnv> = async (context) => {
  const delivery = await receiveDelivery(
      context.req.raw,
      context.env,
      'reservation.request',
      16384,
    ),
    body = await releaseHostParticipation(context.env, delivery.issuer, delivery.body);
  return context.json({
    message: await signedDelivery(
      context.env,
      delivery.issuer,
      API_PATHS.participationRelease,
      'reservation.response',
      body,
      { replyTo: delivery.nonce },
    ),
  });
};
export const participationStatus: Handler<AuthEnv> = async (context) => {
  const delivery = await receiveDelivery(
      context.req.raw,
      context.env,
      'reservation.request',
      16384,
    ),
    body = await hostParticipationStatus(context.env, delivery.issuer, delivery.body);
  return context.json({
    message: await signedDelivery(
      context.env,
      delivery.issuer,
      API_PATHS.participationStatus,
      'reservation.response',
      body,
      { replyTo: delivery.nonce },
    ),
  });
};
export const participationExchange: Handler<AuthEnv> = async (context) => {
  const input = await context.req.json().catch(() => null);
  const loginSecret = getCookie(context, 'qr_foreign_login');
  if (loginSecret) {
    const login = await foreignLoginSession(context.env, loginSecret),
      proof = await verifyParticipationTicket(context.env, input?.ticket);
    if (
      proof.iss !== login.peerOrigin ||
      proof.sub !== login.sourceActorId ||
      proof.sourceOrganizationId !== login.sourceOrganizationId
    )
      throw new OrganizationError('PARTICIPATION_TICKET_BINDING', 401);
  }
  const result = await exchangeParticipation(context.env, input);
  setSession(context, result.row.id, result.secret, result.row.sessionExpiresAt);
  context.header('Cache-Control', 'no-store');
  return context.json({ reservationId: result.row.id });
};
export const participationLogout: Handler<AuthEnv> = async (context) => {
  const delivery = await receiveDelivery(
      context.req.raw,
      context.env,
      'reservation.request',
      16384,
    ),
    body = await logoutHostParticipation(context.env, delivery.issuer, delivery.body);
  return context.json({
    message: await signedDelivery(
      context.env,
      delivery.issuer,
      API_PATHS.participationLogout,
      'reservation.response',
      body,
      { replyTo: delivery.nonce },
    ),
  });
};
export const participationView: Handler<AuthEnv> = async (context) => {
  const identity = await participationSession(
    context.env,
    secretFor(context),
    reservationId(context),
  );
  if (identity.reservation.id !== reservationId(context))
    throw new OrganizationError('SESSION_REQUIRED', 401);
  context.header('Cache-Control', 'no-store');
  return context.json(publicSession(identity));
};
export const participationResume: Handler<AuthEnv> = async (context) => {
  const input = await context.req.json().catch(() => null);
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length
  )
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const identity = await resumeParticipation(
    context.env,
    secretFor(context),
    reservationId(context),
  );
  context.header('Cache-Control', 'no-store');
  return context.json(publicSession(identity));
};
export const participationConfig: Handler<AuthEnv> = async (context) => {
  const identity = await participationSession(
      context.env,
      secretFor(context),
      reservationId(context),
    ),
    definition = await loadMatchDefinition(
      context.env,
      {
        owner: identity.instance.owner,
        profile:
          identity.reservation.mode === 'casual'
            ? `${context.env.GAME_CONFIG_PROFILE}-casual`
            : context.env.GAME_CONFIG_PROFILE,
      },
      identity.reservation.actorId,
    );
  context.header('Cache-Control', 'no-store');
  return context.json({
    competition: definition.competition,
    playersPerMatch: definition.playersPerMatch,
    rules: definition.rules,
  });
};
export const participationCancel: Handler<AuthEnv> = async (context) => {
  const input = await context.req.json().catch(() => null);
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).join(',') !== 'forfeit' ||
    typeof input.forfeit !== 'boolean'
  )
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const identity = await participationSession(
      context.env,
      secretFor(context),
      reservationId(context),
    ),
    row = identity.reservation;
  const result = await context.env.MATCHMAKER.getByName(
    identity.instance.organizationId,
  ).cancel(row.actorId, row.roomId ?? '', input.forfeit, row.instanceId, input.forfeit);
  if (!result.ok)
    throw new OrganizationError(
      result.code,
      result.code === 'GAME_DATABASE_UNAVAILABLE' ? 503 : 409,
    );
  const db = federationDatabase(context.env);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(federationReservations)
        .set({ state: 'closed', allowedUntil: 0 })
        .where(
          and(
            eq(federationReservations.id, row.id),
            eq(federationReservations.actorId, row.actorId),
          ),
        ),
    );
  });
  deleteCookie(context, `qr_fed_${row.id}`, cookieOptions);
  return context.json({ ok: true });
};
export const participationSocket: Handler<AuthEnv> = async (context) => {
  const identity = await resumeParticipation(
      context.env,
      secretFor(context),
      reservationId(context),
    ),
    headers = new Headers(context.req.raw.headers),
    roomId = identity.reservation.roomId;
  if (!roomId) throw new OrganizationError('PARTICIPATION_BINDING', 403);
  const game =
    identity.reservation.mode === 'room'
      ? roomResult(
          await context.env.GAME_ROOM.getByName(userRoomName(roomId)).userRoomGameSession(
            identity.reservation.actorId,
            identity.token,
          ),
        )
      : { room: roomId, token: identity.token };
  if (
    identity.reservation.mode === 'room' &&
    game.room !== validId(context.req.query('room'))
  )
    throw new OrganizationError('PARTICIPATION_BINDING', 403);
  headers.set('X-Game-Session', game.token);
  headers.set('X-Game-Instance', identity.instance.id);
  return context.env.GAME_ROOM.getByName(matchRoomName(game.room)).fetch(
    new Request(context.req.raw, { headers }),
  );
};
