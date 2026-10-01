import type { Handler, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { API_PATHS } from '../../shared/api-paths';
import { validateBroughtSet, validateRoomSettings } from '../../shared/rooms';
import { type AuthEnv, authenticate } from '../auth/handlers';
import { loadMatchDefinition } from '../catalog/database';
import { OrganizationError, validId } from '../organization/access';
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
  saveCasualSettings,
} from './database';
import { history, report } from './reports';
import { roomResult } from './rpc';

export const optionalAuth: MiddlewareHandler<AuthEnv> = (c, next) =>
  c.req.header('Authorization') ? authenticate(c, next) : next();
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'Strict' as const,
  path: '/api/play',
  maxAge: guestLifetime / 1000,
};
function matchCookie(
  c: Parameters<Handler<AuthEnv>>[0],
  result: { room: string; token: string; expires: number },
  lobby = false,
) {
  setCookie(c, `${lobby ? 'qr_room' : 'qr_match'}_${result.room}`, result.token, {
    ...cookieOptions,
    path: lobby ? '/api/play' : '/api/matchmaking',
    maxAge: Math.max(0, Math.floor((result.expires - Date.now()) / 1000)),
  });
}
async function body(c: Parameters<Handler<AuthEnv>>[0]) {
  const input: unknown = await c.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_SETUP', 400);
  return input as Record<string, unknown>;
}
async function context(
  c: Parameters<Handler<AuthEnv>>[0],
  mode: 'casual' | 'room',
  existing = false,
  creating = false,
) {
  return participantContext(
    c.env,
    c.req.query('instance') ?? '',
    mode,
    c.get('subject'),
    getCookie(c, 'qr_guest'),
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
    return await loadMatchDefinition({
      ...env,
      GAME_OWNER: instance.owner,
      GAME_CONFIG_PROFILE: `${env.GAME_CONFIG_PROFILE}-casual`,
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

export const guest: Handler<AuthEnv> = async (c) => {
  const input = await body(c);
  if (Object.keys(input).length) {
    await createGuest(c.env, input, getCookie(c, 'qr_guest') ?? '');
    setCookie(c, 'qr_guest', getCookie(c, 'qr_guest') ?? '', cookieOptions);
  } else if (!getCookie(c, 'qr_guest')) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    setCookie(c, 'qr_guest', token, cookieOptions);
    return c.json({ name: null });
  }
  try {
    const identity = await guestIdentity(c.env, getCookie(c, 'qr_guest') ?? '');
    return c.json({ name: identity.name, id: identity.actorId });
  } catch (error) {
    if (error instanceof OrganizationError && error.code === 'GUEST_REQUIRED')
      return c.json({ name: null });
    throw error;
  }
};
export const instances: Handler<AuthEnv> = async (c) =>
  c.json({ instances: await publicInstances(c.env) });
export const casual: Handler<AuthEnv> = async (c) => {
  if (c.req.path === API_PATHS.casualConfig && !c.get('subject')) {
    const instance = await previewInstance(c.env, c.req.query('instance') ?? '');
    if (!instance.casualConfig.casualGuests)
      throw new OrganizationError('GUEST_NOT_ALLOWED', 403);
    if (!instance.casualConfig.enabled || instance.casualPauseReason)
      throw new OrganizationError('PARTICIPATION_RESTRICTED', 403);
    const definition = await casualDefinition(c.env, instance);
    return c.json({
      playersPerMatch: definition.playersPerMatch,
      rules: definition.rules,
    });
  }
  const existing = [API_PATHS.casualResume, API_PATHS.casualCancel].includes(
    c.req.path as typeof API_PATHS.casualResume,
  );
  const identity = await context(c, 'casual', existing);
  if (c.req.path === API_PATHS.casualConfig) {
    const definition = await casualDefinition(c.env, identity.instance);
    return c.json({
      playersPerMatch: definition.playersPerMatch,
      rules: definition.rules,
    });
  }
  const input = await body(c),
    maker = c.env.MATCHMAKER.getByName(identity.instance.organizationId);
  if (c.req.path === API_PATHS.casualCancel) {
    const room = validId(input.room),
      result = await maker.cancel(identity.actor.id, room, false, identity.instance.id);
    if (!result.ok) throw new OrganizationError(result.code, 409);
    deleteCookie(c, `qr_match_${room}`, {
      path: '/api/matchmaking',
      secure: true,
      sameSite: 'Strict',
    });
    return c.json(result);
  }
  if (!identity.actor.name) throw new OrganizationError('PROFILE_REQUIRED', 409);
  if (!existing) await ensureCasualCatalog(c.env, identity.instance.id);
  const result = await maker.enter(
    identity.actor.id,
    identity.actor.name,
    undefined,
    c.req.path === API_PATHS.casualResume,
    identity.scope,
    identity.actor.guest,
  );
  if (!result.ok)
    throw new OrganizationError(result.code, result.code === 'RATE_LIMIT' ? 429 : 409);
  matchCookie(c, result);
  return c.json({ room: result.room });
};
export const settings: Handler<AuthEnv> = async (c) => {
  const input = await body(c);
  const result = await saveCasualSettings(c.env, c.get('subject'), input);
  const identity = await context(c, 'casual', true);
  await c.env.MATCHMAKER.getByName(
    identity.instance.organizationId,
  ).refreshInstanceWaiting(identity.instance.id);
  return c.json(result);
};
export const sets: Handler<AuthEnv> = async (c) => {
  const input = await body(c);
  return c.json(
    Object.keys(input).length
      ? await mutatePersonalSet(c.env, c.get('subject'), input)
      : { sets: await personalSets(c.env, c.get('subject')) },
  );
};
export const results: Handler<AuthEnv> = async (c) =>
  c.json(await history(c.env, await context(c, 'room', true)));
export const reports: Handler<AuthEnv> = async (c) =>
  c.json(await report(c.env, await context(c, 'room', true), await body(c)));
export const info: Handler<AuthEnv> = async (c) => {
  const input = await body(c),
    room = validId(input.room);
  const view = roomResult(
    await c.env.GAME_ROOM.getByName(`room:${room}`).userRoomInfo(
      typeof input.invite === 'string' ? input.invite : '',
    ),
  );
  const instance = await previewInstance(c.env, view.instanceId, c.get('subject'));
  return c.json({
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
export const list: Handler<AuthEnv> = async (c) => {
  const instance = c.get('subject')
    ? (await context(c, 'room')).instance
    : await previewInstance(c.env, c.req.query('instance') ?? '');
  if (!c.get('subject') && !instance.casualConfig.roomGuests)
    throw new OrganizationError('GUEST_NOT_ALLOWED', 403);
  const rows = await roomIds(c.env, instance.id);
  const results = await Promise.allSettled(
    rows.map((r) => c.env.GAME_ROOM.getByName(`room:${r.id}`).userRoomInfo()),
  );
  return c.json({
    rooms: results.flatMap((r) =>
      r.status === 'fulfilled' && 'settings' in r.value && r.value.settings.public
        ? [r.value]
        : [],
    ),
  });
};
export const options: Handler<AuthEnv> = async (c) => {
  const identity = await context(c, 'room', true);
  return c.json({
    categories: await roomOptions(c.env, identity.instance.id),
    config: identity.instance.casualConfig,
  });
};
export const roomActions: Handler<AuthEnv> = async (c) => {
  const input = await body(c),
    id = validId(input.room);
  const creating = c.req.path === API_PATHS.roomCreate;
  if (creating || (c.req.path === API_PATHS.roomMutate && input.action === 'settings')) {
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
  const identity = await context(c, 'room', existing, creating);
  const room = c.env.GAME_ROOM.getByName(`room:${id}`),
    maker = c.env.MATCHMAKER.getByName(identity.instance.organizationId);
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
      throw new OrganizationError(
        result.code,
        'status' in result
          ? result.status
          : [
                'OTHER_INSTANCE_ACTIVE',
                'RATE_LIMIT',
                'WITHDRAWAL_PENDING',
                'LOGOUT_PENDING',
              ].includes(result.code)
            ? 409
            : 503,
      );
    matchCookie(c, result, true);
    return c.json({ room: id });
  }
  if (c.req.path === API_PATHS.roomJoin) {
    const result = await maker.enterRoom(identity.actor, id, identity.scope, {
      operationId: validId(input.operationId),
      password: typeof input.password === 'string' ? input.password : '',
      invite: typeof input.invite === 'string' ? input.invite : '',
    });
    if (!result.ok)
      throw new OrganizationError(result.code, result.code === 'RATE_LIMIT' ? 429 : 409);
    matchCookie(c, result, true);
    return c.json({ room: roomResult(await room.userRoomView(identity.actor.id)) });
  }
  const token = getCookie(c, `qr_room_${id}`);
  if (!token) throw new OrganizationError('SESSION_REQUIRED', 401);
  // The account or guest credential and the room credential must identify the same participant.
  const view = roomResult(await room.userRoomView(identity.actor.id, token));
  if (view.instanceId !== identity.instance.id)
    throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
  if (c.req.path === API_PATHS.roomView) return c.json({ room: view });
  if (c.req.path === API_PATHS.roomOriginals)
    return c.json(roomResult(await room.userRoomOriginals(identity.actor.id)));
  if (c.req.path === API_PATHS.roomMutate)
    return c.json(roomResult(await room.mutateUserRoom(identity.actor, input)));
  if (c.req.path === API_PATHS.roomGame) {
    const session = roomResult(await room.userRoomGameSession(identity.actor.id, token));
    matchCookie(c, { ...session, expires: Date.now() + 12 * 3600000 });
    return c.json({ room: session.room });
  }
  const result = await maker.cancel(identity.actor.id, id, false, identity.instance.id);
  if (!result.ok) throw new OrganizationError(result.code, 409);
  deleteCookie(c, `qr_room_${id}`, cookieOptions);
  return c.json(result);
};
export const socket: Handler<AuthEnv> = async (c) => {
  const room = validId(c.req.query('room')),
    token = getCookie(c, `qr_room_${room}`);
  if (!token) throw new OrganizationError('SESSION_REQUIRED', 401);
  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Game-Session', token);
  headers.set('X-Game-Instance', c.req.query('instance') ?? '');
  return c.env.GAME_ROOM.getByName(`room:${room}`).fetch(
    new Request(c.req.raw, { headers }),
  );
};
