import type { Context, Handler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env.ts';
import { parseJoin } from './validation.ts';

export function rejectLargeGameBody(context: Context<{ Bindings: Env }>) {
  return context.json({ code: 'INVALID_SETUP' }, 413);
}

export const joinGame: Handler<{ Bindings: Env }> = async (context) => {
  if (Number(context.req.header('Content-Length') ?? 0) > 1024)
    return context.json({ code: 'INVALID_SETUP' }, 400);
  const body = await context.req.text();
  if (new TextEncoder().encode(body).length > 1024)
    return context.json({ code: 'INVALID_SETUP' }, 400);

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return context.json({ code: 'INVALID_SETUP' }, 400);
  }
  const input = parseJoin(value);
  if (!input) return context.json({ code: 'INVALID_SETUP' }, 400);

  const room = context.req.query('room') as string;
  const cookie = `qr_dev_${room}`;
  const result = await context.env.GAME_ROOM.getByName(`1b-hiragana:${room}`).join(
    input,
    getCookie(context, cookie),
  );
  if (!result.ok)
    return context.json(
      { code: result.code },
      result.code === 'GAME_DATABASE_UNAVAILABLE'
        ? 503
        : result.code === 'CONNECTION_LIMIT'
          ? 429
          : 409,
    );

  setCookie(context, cookie, result.token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: new URL(context.req.url).protocol === 'https:',
    path: '/api/game',
    maxAge: 86400,
  });
  return context.json({ ok: true });
};

export const connectGame: Handler<{ Bindings: Env }> = async (context) => {
  const room = context.req.query('room') as string;
  const token = getCookie(context, `qr_dev_${room}`);
  if (!token) return context.json({ code: 'SESSION_REQUIRED' }, 401);

  const headers = new Headers(context.req.raw.headers);
  headers.set('X-Game-Session', token);
  return context.env.GAME_ROOM.getByName(`1b-hiragana:${room}`).fetch(
    new Request(context.req.raw, { headers }),
  );
};
