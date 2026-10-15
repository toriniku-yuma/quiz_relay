import { and, eq } from 'drizzle-orm';
import type { Handler } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { validateBroughtSet, validateRoomSettings } from '../../shared/rooms.ts';
import type { AuthEnv } from '../auth/handlers.ts';
import { changeD1 } from '../db/d1.ts';
import {
  federationActors,
  federationReservations,
  instances,
  organizations,
  personalQuestionSets,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { userRoomName } from '../game/room-names.ts';
import { matchmaker } from '../matchmaking/instance.ts';
import { actorForSubject, OrganizationError, validId } from '../organization/access.ts';
import { allowedInstanceActors, organizationIdentity } from '../organization/database.ts';
import { requireUnrestricted } from '../organization/moderation.ts';
import {
  mutatePersonalSet,
  personalSets,
  roomIds,
  roomOptions,
  roomSharedSources,
} from '../rooms/database.ts';
import { roomResult } from '../rooms/rpc.ts';
import { requireParticipationReceiving } from './admission.ts';
import { foreignLoginSession } from './login.ts';
import {
  participationScope,
  participationSession,
  refreshParticipationAccess,
  reservationAdmission,
} from './participation.ts';
import { cookieOptions, reservationId, secretFor } from './participation-handlers.ts';
import { releaseHostParticipation } from './slots.ts';
import { federationDatabase } from './transport.ts';

async function publicRoomList(env: Env, instanceId: string) {
  const rooms = await roomIds(env, instanceId),
    views = await Promise.allSettled(
      rooms.map((room) => env.GAME_ROOM.getByName(userRoomName(room.id)).userRoomInfo()),
    );
  return {
    rooms: views.flatMap((view) =>
      view.status === 'fulfilled' &&
      'settings' in view.value &&
      view.value.settings.public
        ? [view.value]
        : [],
    ),
  };
}
export const foreignLoginRoomActions: Handler<AuthEnv> = async (context) => {
  const account = await foreignLoginSession(
      context.env,
      getCookie(context, 'qr_foreign_login') ?? '',
    ),
    input = await context.req.json().catch(() => null),
    db = federationDatabase(context.env);
  const action = context.req.param('action');
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !['instanceId', ...(action === 'sets' ? ['body,instanceId'] : [])].includes(
      Object.keys(input).sort().join(','),
    ) ||
    (input.body !== undefined &&
      (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)))
  )
    throw new OrganizationError('INVALID_SETUP', 400);
  const [instance] = await db
    .select()
    .from(instances)
    .where(eq(instances.id, validId(input.instanceId)));
  if (instance?.state !== 'published' || instance.casualPauseReason)
    throw new OrganizationError('INSTANCE_NOT_AVAILABLE', 403);
  await requireParticipationReceiving(db, account.peerOrigin, 'room');
  if (action === 'list')
    return context.json(await publicRoomList(context.env, instance.id));
  if (action === 'options')
    return context.json({
      categories: await roomOptions(context.env, instance.id),
      sharedSources: await roomSharedSources(context.env, instance.id),
      config: instance.casualConfig,
    });
  if (action === 'sets') {
    const [organization] = await db.select().from(organizations).limit(1);
    if (!organization) throw new OrganizationError('SETUP_REQUIRED', 409);
    const actor = await actorForSubject(
      organization.identityNamespace,
      `federation:${account.peerOrigin}:${account.sourceActorId}`,
    );
    if (input.body && Object.keys(input.body).length) {
      const subject = `federation:${account.peerOrigin}:${account.sourceActorId}`;
      await organizationIdentity(db, subject, organization);
      await changeD1(db, async (writes) => {
        writes.push(
          db
            .insert(federationActors)
            .values({
              actorId: actor,
              peerOrigin: account.peerOrigin,
              sourceActorId: account.sourceActorId,
              displayName: account.displayName,
            })
            .onConflictDoUpdate({
              target: federationActors.actorId,
              set: { displayName: account.displayName },
            }),
        );
      });
      return context.json(await mutatePersonalSet(context.env, subject, input.body));
    }
    return context.json({
      sets: await db
        .select()
        .from(personalQuestionSets)
        .where(
          and(
            eq(personalQuestionSets.organizationId, instance.organizationId),
            eq(personalQuestionSets.authorId, actor),
          ),
        ),
    });
  }
  throw new OrganizationError('INVALID_OPERATION', 400);
};

async function identity(context: Parameters<Handler<AuthEnv>>[0]) {
  const identity = await participationSession(
    context.env,
    secretFor(context),
    reservationId(context),
  );
  if (identity.reservation.mode !== 'room')
    throw new OrganizationError('PARTICIPATION_BINDING', 403);
  return identity;
}
export const foreignRoomActions: Handler<AuthEnv> = async (context) => {
  const session = await identity(context),
    row = session.reservation,
    instance = session.instance,
    action = context.req.param('action'),
    input = await context.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_SETUP', 400);
  context.header('Cache-Control', 'no-store');
  const env = context.env,
    db = federationDatabase(env),
    scope = participationScope(instance, 'room'),
    actor = { id: row.actorId, name: row.displayName, guest: false },
    subject = `federation:${row.peerOrigin}:${row.sourceActorId}`;
  if (action === 'list') {
    await refreshParticipationAccess(
      env,
      instance.id,
      [actor.id],
      true,
      row.matchId ?? undefined,
    );
    if (!(await allowedInstanceActors(env, scope, [actor.id])).includes(actor.id))
      throw new OrganizationError('PARTICIPATION_RESTRICTED', 403);
    return context.json(await publicRoomList(env, instance.id));
  }
  if (action === 'options')
    return context.json({
      categories: await roomOptions(env, instance.id),
      sharedSources: await roomSharedSources(env, instance.id),
      config: instance.casualConfig,
    });
  if (action === 'sets')
    return context.json(
      Object.keys(input).length
        ? await mutatePersonalSet(env, subject, input)
        : { sets: await personalSets(env, subject) },
    );
  const room = validId(input.room),
    lobby = env.GAME_ROOM.getByName(userRoomName(room)),
    maker = matchmaker(env);
  if (action === 'info') {
    const view = roomResult(
      await lobby.userRoomInfo(typeof input.invite === 'string' ? input.invite : ''),
    );
    if (view.instanceId !== instance.id)
      throw new OrganizationError('INSTANCE_MISMATCH', 403);
    return context.json({ room: view });
  }
  if (action === 'create' || action === 'join') {
    if (row.roomId && row.roomId !== room)
      throw new OrganizationError('PARTICIPATION_BINDING', 409);
    if (typeof input.password === 'string' && input.password.length > 128)
      throw new OrganizationError('INVALID_PASSWORD', 400);
    if (action === 'create') {
      const settings = validateRoomSettings(input.settings);
      if (settings.source === 'original') validateBroughtSet(input.questions);
      await requireUnrestricted(
        db,
        instance.organizationId,
        actor.id,
        instance.id,
        'rooms',
      );
    }
    await refreshParticipationAccess(
      env,
      instance.id,
      [actor.id],
      true,
      row.matchId ?? undefined,
    );
    if (!(await allowedInstanceActors(env, scope, [actor.id])).includes(actor.id))
      throw new OrganizationError('PARTICIPATION_RESTRICTED', 403);
    // Save the intended parent before an RPC whose outcome may be unknown. A
    // retry is bound to this parent and operation; it cannot enter a second room.
    await changeD1(db, async (writes) => {
      const [current] = await db
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.id, row.id));
      if (
        !current ||
        current.state === 'closed' ||
        (current.roomId && current.roomId !== room)
      )
        throw new OrganizationError('PARTICIPATION_BINDING', 409);
      writes.push(
        db
          .update(federationReservations)
          .set({ roomId: room })
          .where(
            and(
              eq(federationReservations.id, row.id),
              eq(federationReservations.state, 'exchanged'),
            ),
          ),
      );
    });
    validId(input.operationId);
    const result = await maker.enterRoom(
      actor,
      room,
      scope,
      {
        operationId: row.operationId,
        password: typeof input.password === 'string' ? input.password : '',
        invite: typeof input.invite === 'string' ? input.invite : '',
      },
      action === 'create' ? { ...input, operationId: row.operationId } : undefined,
    );
    if (!result.ok)
      throw new OrganizationError(
        result.code,
        'status' in result ? result.status : result.code === 'RATE_LIMIT' ? 429 : 409,
      );
    return context.json({
      room: roomResult(await lobby.userRoomView(actor.id, result.token)),
    });
  }
  if (row.roomId !== room) throw new OrganizationError('PARTICIPATION_BINDING', 403);
  const admission = await reservationAdmission(env, row, instance);
  if (!admission.ok) throw new OrganizationError(admission.code, 409);
  const view = roomResult(await lobby.userRoomView(actor.id, admission.token));
  if (view.instanceId !== instance.id)
    throw new OrganizationError('INSTANCE_MISMATCH', 403);
  if (action === 'view') return context.json({ room: view });
  if (action === 'originals')
    return context.json(roomResult(await lobby.userRoomOriginals(actor.id)));
  if (action === 'mutate')
    return context.json(roomResult(await lobby.mutateUserRoom(actor, input)));
  if (action === 'game') {
    const game = roomResult(await lobby.userRoomGameSession(actor.id, admission.token));
    return context.json({ room: game.room });
  }
  if (action === 'leave') {
    const result = await maker.cancel(
      actor.id,
      room,
      false,
      instance.id,
      input.force === true,
    );
    if (!result.ok) throw new OrganizationError(result.code, 409);
    await releaseHostParticipation(env, row.peerOrigin, {
      operationId: row.operationId,
      sourceActorId: row.sourceActorId,
    });
    deleteCookie(context, `qr_fed_${row.id}`, cookieOptions);
    return context.json({ ok: true });
  }
  throw new OrganizationError('INVALID_OPERATION', 400);
};
export const foreignRoomSocket: Handler<AuthEnv> = async (context) => {
  const session = await identity(context),
    row = session.reservation;
  if (!row.roomId) throw new OrganizationError('ROOM_NOT_FOUND', 404);
  const admission = await reservationAdmission(context.env, row, session.instance);
  if (!admission.ok) throw new OrganizationError(admission.code, 409);
  const headers = new Headers(context.req.raw.headers);
  headers.set('X-Game-Session', admission.token);
  headers.set('X-Game-Instance', session.instance.id);
  return context.env.GAME_ROOM.getByName(userRoomName(row.roomId)).fetch(
    new Request(context.req.raw, { headers }),
  );
};
