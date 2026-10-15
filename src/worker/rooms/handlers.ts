import type { Handler, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { API_PATHS } from '../../shared/api-paths.ts';
import { resultsQuery } from '../../shared/results.ts';
import { validateBroughtSet, validateRoomSettings } from '../../shared/rooms.ts';
import { type AuthEnv, authenticate } from '../auth/handlers.ts';
import { loadMatchDefinition } from '../catalog/database.ts';
import { userRoomName } from '../game/room-names.ts';
import { matchmaker } from '../matchmaking/instance.ts';
import { OrganizationError, validId } from '../organization/access.ts';
import {
  createGuest,
  ensureCasualCatalog,
  guestIdentity,
  guestLifetime,
  mutatePersonalSet,
  participantContext,
  personalSets,
  previewInstance,
  publicInstances,
  roomIds,
  roomOptions,
  roomSharedSources,
  saveCasualSettings,
} from './database.ts';
import { history, report } from './reports.ts';
import { roomResult } from './rpc.ts';

export const optionalAuth: MiddlewareHandler<AuthEnv> = (httpContext, next) =>
  httpContext.req.header('Authorization') ? authenticate(httpContext, next) : next();
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'Strict' as const,
  path: '/api/play',
  maxAge: guestLifetime / 1000,
};
function matchCookie(
  httpContext: Parameters<Handler<AuthEnv>>[0],
  result: { room: string; token: string; expires: number },
  lobby = false,
) {
  setCookie(
    httpContext,
    `${lobby ? 'qr_room' : 'qr_match'}_${result.room}`,
    result.token,
    {
      ...cookieOptions,
      path: lobby ? '/api/play' : '/api/matchmaking',
      maxAge: Math.max(0, Math.floor((result.expires - Date.now()) / 1000)),
    },
  );
}
async function body(httpContext: Parameters<Handler<AuthEnv>>[0]) {
  const input: unknown = await httpContext.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_SETUP', 400);
  return input as Record<string, unknown>;
}
async function context(
  httpContext: Parameters<Handler<AuthEnv>>[0],
  mode: 'casual' | 'room',
  existing = false,
  creating = false,
) {
  return participantContext(
    httpContext.env,
    httpContext.req.query('instance') ?? '',
    mode,
    httpContext.get('subject'),
    getCookie(httpContext, 'qr_guest'),
    existing,
    creating,
  );
}
async function casualDefinition(
  env: AuthEnv['Bindings'],
  instance: { id: string; owner: string },
) {
  await ensureCasualCatalog(env, instance.id);
  try {
    return await loadMatchDefinition(env, {
      owner: instance.owner,
      profile: `${env.GAME_CONFIG_PROFILE}-casual`,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ['NO_RANKED_QUESTIONS', 'RANKED_NOT_CONFIGURED'].includes(error.message)
    )
      throw new OrganizationError('NO_ROOM_QUESTIONS', 409);
    throw error;
  }
}

export const guest: Handler<AuthEnv> = async (httpContext) => {
  const input = await body(httpContext);
  if (Object.keys(input).length) {
    await createGuest(httpContext.env, input, getCookie(httpContext, 'qr_guest') ?? '');
    setCookie(
      httpContext,
      'qr_guest',
      getCookie(httpContext, 'qr_guest') ?? '',
      cookieOptions,
    );
  } else if (!getCookie(httpContext, 'qr_guest')) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    setCookie(httpContext, 'qr_guest', token, cookieOptions);
    return httpContext.json({ name: null });
  }
  try {
    const identity = await guestIdentity(
      httpContext.env,
      getCookie(httpContext, 'qr_guest') ?? '',
    );
    return httpContext.json({ name: identity.name, id: identity.actorId });
  } catch (error) {
    if (error instanceof OrganizationError && error.code === 'GUEST_REQUIRED')
      return httpContext.json({ name: null });
    throw error;
  }
};
export const instances: Handler<AuthEnv> = async (httpContext) =>
  httpContext.json({ instances: await publicInstances(httpContext.env) });
export const casual: Handler<AuthEnv> = async (httpContext) => {
  if (httpContext.req.path === API_PATHS.casualConfig && !httpContext.get('subject')) {
    const instance = await previewInstance(
      httpContext.env,
      httpContext.req.query('instance') ?? '',
    );
    if (!instance.casualConfig.casualGuests)
      throw new OrganizationError('GUEST_NOT_ALLOWED', 403);
    if (!instance.casualConfig.enabled || instance.casualPauseReason)
      throw new OrganizationError('PARTICIPATION_RESTRICTED', 403);
    const definition = await casualDefinition(httpContext.env, instance);
    return httpContext.json({
      playersPerMatch: definition.playersPerMatch,
      rules: definition.rules,
    });
  }
  const existing = [API_PATHS.casualResume, API_PATHS.casualCancel].includes(
    httpContext.req.path as typeof API_PATHS.casualResume,
  );
  const identity = await context(httpContext, 'casual', existing);
  if (httpContext.req.path === API_PATHS.casualConfig) {
    const definition = await casualDefinition(httpContext.env, identity.instance);
    return httpContext.json({
      playersPerMatch: definition.playersPerMatch,
      rules: definition.rules,
    });
  }
  const input = await body(httpContext),
    maker = matchmaker(httpContext.env);
  if (httpContext.req.path === API_PATHS.casualCancel) {
    const operationCancel = input.operationId !== undefined;
    if (
      operationCancel
        ? Object.keys(input).join(',') !== 'operationId'
        : Object.keys(input).some((key) => !['room', 'forfeit'].includes(key)) ||
          (input.forfeit !== undefined && typeof input.forfeit !== 'boolean')
    )
      throw new OrganizationError('INVALID_SETUP', 400);
    const room = operationCancel ? undefined : validId(input.room),
      result = operationCancel
        ? await maker.cancelAdmission(
            identity.actor.id,
            validId(input.operationId),
            identity.instance.id,
            'casual',
          )
        : await maker.cancel(
            identity.actor.id,
            room as string,
            false,
            identity.instance.id,
            input.forfeit === true,
          );
    if (!result.ok)
      throw new OrganizationError(
        result.code,
        result.code === 'GAME_DATABASE_UNAVAILABLE' ? 503 : 409,
      );
    if (room)
      deleteCookie(httpContext, `qr_match_${room}`, {
        path: '/api/matchmaking',
        secure: true,
        sameSite: 'Strict',
      });
    return httpContext.json(result);
  }
  if (!identity.actor.name) throw new OrganizationError('PROFILE_REQUIRED', 409);
  if (!existing) await ensureCasualCatalog(httpContext.env, identity.instance.id);
  const result = await maker.enter(
    identity.actor.id,
    identity.actor.name,
    httpContext.req.path === API_PATHS.casualResume,
    identity.scope,
    identity.actor.guest,
    input.operationId === undefined ? undefined : validId(input.operationId),
  );
  if (!result.ok)
    return httpContext.json(
      result,
      result.code === 'GAME_DATABASE_UNAVAILABLE'
        ? 503
        : result.code === 'RATE_LIMIT'
          ? 429
          : 409,
    );
  matchCookie(httpContext, result);
  return httpContext.json({ room: result.room, operationId: result.operationId });
};
export const settings: Handler<AuthEnv> = async (httpContext) => {
  const input = await body(httpContext);
  const result = await saveCasualSettings(
    httpContext.env,
    httpContext.get('subject'),
    input,
  );
  const identity = await context(httpContext, 'casual', true);
  await matchmaker(httpContext.env).refreshInstanceWaiting(identity.instance.id);
  return httpContext.json(result);
};
export const sets: Handler<AuthEnv> = async (httpContext) => {
  const input = await body(httpContext);
  return httpContext.json(
    Object.keys(input).length
      ? await mutatePersonalSet(httpContext.env, httpContext.get('subject'), input)
      : { sets: await personalSets(httpContext.env, httpContext.get('subject')) },
  );
};
export const results: Handler<AuthEnv> = async (httpContext) => {
  let query: ReturnType<typeof resultsQuery>;
  try {
    query = resultsQuery(await body(httpContext));
  } catch {
    throw new OrganizationError('INVALID_SETUP', 400);
  }
  return httpContext.json(
    await history(httpContext.env, await context(httpContext, 'room', true), query),
  );
};
export const reports: Handler<AuthEnv> = async (httpContext) =>
  httpContext.json(
    await report(
      httpContext.env,
      await context(httpContext, 'room', true),
      await body(httpContext),
    ),
  );
export const info: Handler<AuthEnv> = async (httpContext) => {
  const input = await body(httpContext),
    room = validId(input.room);
  const view = roomResult(
    await httpContext.env.GAME_ROOM.getByName(userRoomName(room)).userRoomInfo(
      typeof input.invite === 'string' ? input.invite : '',
    ),
  );
  const instance = await previewInstance(
    httpContext.env,
    view.instanceId,
    httpContext.get('subject'),
  );
  return httpContext.json({
    room: {
      ...view,
      guestAllowed:
        view.settings.guests &&
        instance.casualConfig.roomGuests &&
        !instance.casualPauseReason &&
        instance.state === 'published',
    },
  });
};
export const list: Handler<AuthEnv> = async (httpContext) => {
  const instance = httpContext.get('subject')
    ? (await context(httpContext, 'room')).instance
    : await previewInstance(httpContext.env, httpContext.req.query('instance') ?? '');
  if (!httpContext.get('subject') && !instance.casualConfig.roomGuests)
    throw new OrganizationError('GUEST_NOT_ALLOWED', 403);
  const rows = await roomIds(httpContext.env, instance.id);
  const results = await Promise.allSettled(
    rows.map((room) =>
      httpContext.env.GAME_ROOM.getByName(userRoomName(room.id)).userRoomInfo(),
    ),
  );
  return httpContext.json({
    rooms: results.flatMap((result) =>
      result.status === 'fulfilled' &&
      'settings' in result.value &&
      result.value.settings.public
        ? [result.value]
        : [],
    ),
  });
};
export const options: Handler<AuthEnv> = async (httpContext) => {
  const identity = await context(httpContext, 'room', true);
  return httpContext.json({
    categories: await roomOptions(httpContext.env, identity.instance.id),
    sharedSources: await roomSharedSources(httpContext.env, identity.instance.id),
    config: identity.instance.casualConfig,
  });
};
export const roomActions: Handler<AuthEnv> = async (httpContext) => {
  const input = await body(httpContext),
    id = validId(input.room);
  const creating = httpContext.req.path === API_PATHS.roomCreate;
  if (
    creating ||
    (httpContext.req.path === API_PATHS.roomMutate && input.action === 'settings')
  ) {
    try {
      const settings = validateRoomSettings(input.settings);
      if (settings.source === 'original' && input.questions !== undefined)
        validateBroughtSet(input.questions);
      if (creating && settings.source === 'original' && input.questions === undefined)
        throw new Error('MISSING_QUESTIONS');
    } catch {
      throw new OrganizationError('INVALID_SETUP', 400);
    }
  }
  const existing = !creating;
  const identity = await context(httpContext, 'room', existing, creating);
  const room = httpContext.env.GAME_ROOM.getByName(userRoomName(id)),
    maker = matchmaker(httpContext.env);
  if (creating) {
    const result = await maker.enterRoom(
      identity.actor,
      id,
      identity.scope,
      {
        operationId: validId(input.operationId),
        password: typeof input.password === 'string' ? input.password : '',
        invite: '',
      },
      input,
    );
    if (!result.ok)
      return httpContext.json(
        result,
        result.code === 'RATE_LIMIT'
          ? 429
          : result.code === 'GAME_DATABASE_UNAVAILABLE'
            ? 503
            : 'status' in result
              ? result.status
              : 409,
      );
    matchCookie(httpContext, result, true);
    return httpContext.json({ room: id });
  }
  if (httpContext.req.path === API_PATHS.roomJoin) {
    const result = await maker.enterRoom(identity.actor, id, identity.scope, {
      operationId: validId(input.operationId),
      password: typeof input.password === 'string' ? input.password : '',
      invite: typeof input.invite === 'string' ? input.invite : '',
    });
    if (!result.ok)
      return httpContext.json(
        result,
        result.code === 'RATE_LIMIT'
          ? 429
          : result.code === 'GAME_DATABASE_UNAVAILABLE'
            ? 503
            : 'status' in result
              ? result.status
              : 409,
      );
    matchCookie(httpContext, result, true);
    return httpContext.json({
      room: roomResult(await room.userRoomView(identity.actor.id)),
    });
  }
  const token = getCookie(httpContext, `qr_room_${id}`);
  if (!token) throw new OrganizationError('SESSION_REQUIRED', 401);
  // The account or guest credential and the room credential must identify the same participant.
  const view = roomResult(await room.userRoomView(identity.actor.id, token));
  if (view.instanceId !== identity.instance.id)
    throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
  if (httpContext.req.path === API_PATHS.roomView)
    return httpContext.json({ room: view });
  if (httpContext.req.path === API_PATHS.roomOriginals)
    return httpContext.json(roomResult(await room.userRoomOriginals(identity.actor.id)));
  if (httpContext.req.path === API_PATHS.roomMutate)
    return httpContext.json(roomResult(await room.mutateUserRoom(identity.actor, input)));
  if (httpContext.req.path === API_PATHS.roomGame) {
    const session = roomResult(await room.userRoomGameSession(identity.actor.id, token));
    matchCookie(httpContext, { ...session, expires: Date.now() + 12 * 3600000 });
    return httpContext.json({ room: session.room });
  }
  const result = await maker.cancel(
    identity.actor.id,
    id,
    false,
    identity.instance.id,
    input.force === true,
  );
  if (!result.ok) throw new OrganizationError(result.code, 409);
  deleteCookie(httpContext, `qr_room_${id}`, cookieOptions);
  return httpContext.json(result);
};
export const socket: Handler<AuthEnv> = async (httpContext) => {
  const room = validId(httpContext.req.query('room')),
    token = getCookie(httpContext, `qr_room_${room}`);
  if (!token) throw new OrganizationError('SESSION_REQUIRED', 401);
  const headers = new Headers(httpContext.req.raw.headers);
  headers.set('X-Game-Session', token);
  headers.set('X-Game-Instance', httpContext.req.query('instance') ?? '');
  return httpContext.env.GAME_ROOM.getByName(userRoomName(room)).fetch(
    new Request(httpContext.req.raw, { headers }),
  );
};
