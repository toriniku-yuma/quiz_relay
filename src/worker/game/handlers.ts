import type { Context, Handler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';
import { parseJoin } from './validation';

export function rejectLargeGameBody(c: Context<{ Bindings: Env }>) {
  return c.json({ code: 'INVALID_SETUP' }, 413);
}

export const joinGame: Handler<{ Bindings: Env }> = async (c) => {
  if (Number(c.req.header('Content-Length') ?? 0) > 1024)
    return c.json({ code: 'INVALID_SETUP' }, 400);
  const body = await c.req.text();
  if (new TextEncoder().encode(body).length > 1024)
    return c.json({ code: 'INVALID_SETUP' }, 400);

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return c.json({ code: 'INVALID_SETUP' }, 400);
  }
  const input = parseJoin(value);
  if (!input) return c.json({ code: 'INVALID_SETUP' }, 400);

  const room = c.req.query('room') as string;
  const cookie = `qr_dev_${room}`;
  const result = await c.env.GAME_ROOM.getByName(`1b-hiragana:${room}`).join(
    input,
    getCookie(c, cookie),
  );
  if (!result.ok)
    return c.json({ code: result.code }, result.code === 'CONNECTION_LIMIT' ? 429 : 409);

  setCookie(c, cookie, result.token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/api/game',
    maxAge: 86400,
  });
  return c.json({ ok: true });
};

export const connectGame: Handler<{ Bindings: Env }> = async (c) => {
  const room = c.req.query('room') as string;
  const token = getCookie(c, `qr_dev_${room}`);
  if (!token) return c.json({ code: 'SESSION_REQUIRED' }, 401);

  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Game-Session', token);
  return c.env.GAME_ROOM.getByName(`1b-hiragana:${room}`).fetch(
    new Request(c.req.raw, { headers }),
  );
};
