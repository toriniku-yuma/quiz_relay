import type { Context, Handler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AuthEnv } from '../auth/handlers.ts';
import { loadMatchDefinition } from '../catalog/database.ts';
import { matchRoomName } from '../game/room-names.ts';
import { OrganizationError } from '../organization/access.ts';
import { organizationDatabase, organizationIdentity } from '../organization/database.ts';
import { requireUnrestricted } from '../organization/moderation.ts';

const roomId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export const matchConfig: Handler<AuthEnv> = async (context) => {
  const definition = await loadMatchDefinition(
    context.env,
    { owner: context.get('instanceOwner'), profile: context.env.GAME_CONFIG_PROFILE },
    context.get('actorId'),
  ).catch((error: unknown) => {
    if (
      error instanceof Error &&
      ['NO_RANKED_QUESTIONS', 'RANKED_NOT_CONFIGURED'].includes(error.message)
    )
      throw new OrganizationError(error.message, 409);
    throw error;
  });
  context.header('Cache-Control', 'no-store');
  return context.json({
    competition: definition.competition,
    playersPerMatch: definition.playersPerMatch,
    rules: definition.rules,
  });
};

export const enterMatch: Handler<AuthEnv> = async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return context.json({ code: 'INVALID_SETUP' }, 400);
  const value = body as Record<string, unknown>;
  const resume = context.req.path.endsWith('/resume');
  const name = context.get('profileName');
  if (!resume && !name) return context.json({ code: 'PROFILE_REQUIRED' }, 409);
  if (
    (!resume &&
      (Object.keys(value).some((key) => key !== 'operationId') ||
        (value.operationId !== undefined && !roomId(value.operationId)))) ||
    (resume && Object.keys(value).length !== 0)
  )
    return context.json({ code: 'INVALID_SETUP' }, 400);
  if (!resume) {
    const connection = organizationDatabase(context.env);
    try {
      await requireUnrestricted(
        connection.db,
        context.get('organizationId'),
        context.get('actorId'),
        context.get('instanceId'),
        'ranked',
      );
    } finally {
      await connection.close();
    }
  }
  const result = await context.env.MATCHMAKER.getByName(
    context.get('organizationId'),
  ).enter(
    context.get('actorId'),
    resume ? '' : String(name),
    resume,
    { id: context.get('instanceId'), owner: context.get('instanceOwner') },
    false,
    typeof value.operationId === 'string' ? value.operationId : undefined,
  );
  if (!result.ok)
    return context.json(
      {
        code: result.code,
        ...('instanceId' in result ? { instanceId: result.instanceId } : {}),
        ...('mode' in result ? { mode: result.mode } : {}),
      },
      result.code === 'GAME_DATABASE_UNAVAILABLE'
        ? 503
        : result.code === 'RATE_LIMIT'
          ? 429
          : 409,
    );
  setCookie(context, `qr_match_${result.room}`, result.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/api/matchmaking',
    maxAge: Math.max(0, Math.floor((result.expires - Date.now()) / 1000)),
  });
  return context.json({ room: result.room, operationId: result.operationId });
};

export const cancelMatch: Handler<AuthEnv> = async (context) => {
  const body = await context.req.json().catch(() => null);
  const operationCancel =
    body &&
    roomId(body.operationId) &&
    Object.keys(body).join(',') === 'operationId' &&
    !context.req.path.endsWith('/logout');
  if (
    !operationCancel &&
    (!body || !roomId(body.room) || Object.keys(body).join(',') !== 'room')
  )
    return context.json({ code: 'INVALID_ROOM' }, 400);
  const maker = context.env.MATCHMAKER.getByName(context.get('organizationId'));
  const result = operationCancel
    ? await maker.cancelAdmission(
        context.get('actorId'),
        body.operationId,
        context.get('instanceId'),
      )
    : await maker.cancel(
        context.get('actorId'),
        body.room,
        context.req.path.endsWith('/logout'),
        context.get('instanceId'),
      );
  if (!result.ok)
    return context.json(
      { code: result.code },
      result.code === 'GAME_DATABASE_UNAVAILABLE' ? 503 : 409,
    );
  if (body.room)
    deleteCookie(context, `qr_match_${body.room}`, {
      path: '/api/matchmaking',
      secure: true,
      sameSite: 'Strict',
    });
  return context.json({ ok: true });
};

export const matchSocket: Handler<AuthEnv> = async (context) => {
  const room = context.req.query('room');
  if (!roomId(room)) return context.json({ code: 'INVALID_ROOM' }, 400);
  const token = getCookie(context, `qr_match_${room}`);
  if (!token) return context.json({ code: 'SESSION_REQUIRED' }, 401);
  const headers = new Headers(context.req.raw.headers);
  headers.set('X-Game-Session', token);
  headers.set('X-Game-Instance', context.req.query('instance') ?? '');
  return context.env.GAME_ROOM.getByName(matchRoomName(room)).fetch(
    new Request(context.req.raw, { headers }),
  );
};

export const oversizedMatch = (context: Context<AuthEnv>) =>
  context.json({ code: 'INVALID_SETUP' }, 413);

export const logoutActor: Handler<AuthEnv> = async (context) => {
  const cookies = getCookie(context);
  const rooms = Object.keys(cookies)
    .filter((key) => key.startsWith('qr_match_'))
    .map((key) => key.slice('qr_match_'.length))
    .filter(roomId);
  const { db, close } = organizationDatabase(context.env);
  let identity: Awaited<ReturnType<typeof organizationIdentity>> | null = null;
  try {
    identity = await organizationIdentity(db, context.get('subject'));
  } catch (error) {
    // Before organization setup no account exists, so no matchmaking session can exist.
    if (!(error instanceof OrganizationError) || error.code !== 'SETUP_REQUIRED')
      throw error;
  } finally {
    await close();
  }
  if (identity)
    await context.env.MATCHMAKER.getByName(identity.organization.id).logoutActor(
      identity.account.actorId,
      rooms,
    );
  for (const room of rooms)
    deleteCookie(context, `qr_match_${room}`, {
      path: '/api/matchmaking',
      secure: true,
      sameSite: 'Strict',
    });
  return context.json({ ok: true });
};
