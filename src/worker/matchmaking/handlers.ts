import type { Context, Handler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AuthEnv } from '../auth/handlers';
import { loadMatchDefinition } from '../catalog/database';
import { OrganizationError, organizationEnabled } from '../organization/access';
import { organizationDatabase, organizationIdentity } from '../organization/database';

const roomId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export const matchConfig: Handler<AuthEnv> = async (c) => {
  const definition = await loadMatchDefinition(
    {
      ...c.env,
      GAME_OWNER: c.get('instanceOwner'),
    },
    undefined,
    c.get('actorId'),
  ).catch((error: unknown) => {
    if (
      error instanceof Error &&
      ['NO_RANKED_QUESTIONS', 'RANKED_NOT_CONFIGURED'].includes(error.message)
    )
      throw new OrganizationError(error.message, 409);
    throw error;
  });
  c.header('Cache-Control', 'no-store');
  return c.json({
    competition: definition.competition,
    playersPerMatch: definition.playersPerMatch,
    rules: definition.rules,
  });
};

export const enterMatch: Handler<AuthEnv> = async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return c.json({ code: 'INVALID_SETUP' }, 400);
  const value = body as Record<string, unknown>;
  const resume = c.req.path.endsWith('/resume');
  if (
    (!resume &&
      (Object.keys(value).join(',') !== 'name' ||
        typeof value.name !== 'string' ||
        !value.name.trim() ||
        value.name.length > 24)) ||
    (resume && Object.keys(value).length !== 0)
  )
    return c.json({ code: 'INVALID_SETUP' }, 400);
  const result = await c.env.MATCHMAKER.getByName(c.get('organizationId')).enter(
    c.get('actorId'),
    resume ? '' : String(value.name).trim(),
    undefined,
    resume,
    c.get('instanceId')
      ? { id: c.get('instanceId'), owner: c.get('instanceOwner') }
      : undefined,
  );
  if (!result.ok)
    return c.json(
      {
        code: result.code,
        ...('instanceId' in result ? { instanceId: result.instanceId } : {}),
      },
      result.code === 'GAME_DATABASE_UNAVAILABLE'
        ? 503
        : result.code === 'RATE_LIMIT'
          ? 429
          : 409,
    );
  setCookie(c, `qr_match_${result.room}`, result.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/api/matchmaking',
    maxAge: Math.max(0, Math.floor((result.expires - Date.now()) / 1000)),
  });
  return c.json({ room: result.room });
};

export const cancelMatch: Handler<AuthEnv> = async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !roomId(body.room) || Object.keys(body).join(',') !== 'room')
    return c.json({ code: 'INVALID_ROOM' }, 400);
  const result = await c.env.MATCHMAKER.getByName(c.get('organizationId')).cancel(
    c.get('actorId'),
    body.room,
    c.req.path.endsWith('/logout'),
    c.get('instanceId') || undefined,
  );
  if (!result.ok) return c.json({ code: result.code }, 409);
  deleteCookie(c, `qr_match_${body.room}`, {
    path: '/api/matchmaking',
    secure: true,
    sameSite: 'Strict',
  });
  return c.json({ ok: true });
};

export const matchSocket: Handler<AuthEnv> = async (c) => {
  const room = c.req.query('room');
  if (!roomId(room)) return c.json({ code: 'INVALID_ROOM' }, 400);
  const token = getCookie(c, `qr_match_${room}`);
  if (!token) return c.json({ code: 'SESSION_REQUIRED' }, 401);
  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Game-Session', token);
  headers.set(
    'X-Game-Instance',
    organizationEnabled(c.env) ? (c.req.query('instance') ?? '') : '',
  );
  return c.env.GAME_ROOM.getByName(`1c:${room}`).fetch(
    new Request(c.req.raw, { headers }),
  );
};

export const oversizedMatch = (c: Context<AuthEnv>) =>
  c.json({ code: 'INVALID_SETUP' }, 413);

export const logoutActor: Handler<AuthEnv> = async (c) => {
  let actor = c.get('actorId');
  let organization = c.env.GAME_OWNER;
  if (organizationEnabled(c.env)) {
    const { db, close } = organizationDatabase(c.env);
    try {
      const identity = await organizationIdentity(db, c.get('subject'));
      actor = identity.account.actorId;
      organization = identity.organization.id;
    } catch (error) {
      if (!(error instanceof OrganizationError) || error.code !== 'SETUP_REQUIRED')
        throw error;
    } finally {
      await close();
    }
  }
  const cookies = getCookie(c);
  const rooms = Object.keys(cookies)
    .filter((key) => key.startsWith('qr_match_'))
    .map((key) => key.slice('qr_match_'.length))
    .filter(roomId);
  await c.env.MATCHMAKER.getByName(organization).logoutActor(actor, rooms);
  for (const room of rooms)
    deleteCookie(c, `qr_match_${room}`, {
      path: '/api/matchmaking',
      secure: true,
      sameSite: 'Strict',
    });
  return c.json({ ok: true });
};
