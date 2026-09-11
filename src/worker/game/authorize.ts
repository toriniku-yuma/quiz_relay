import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';

export const authorizeLocalGame: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  c.header('Cache-Control', 'no-store');
  // Viteの本番ビルドでは常にfalse。公開Workerのvarsだけでは有効化できない。
  if (!import.meta.env.DEV || c.env.LOCAL_GAME_ENABLED !== 'true')
    return c.json({ code: 'LOCAL_GAME_DISABLED' }, 404);

  const origin = c.req.header('Origin');
  const url = new URL(c.req.url);
  if (!origin || (origin !== url.origin && origin !== c.env.PROBE_ORIGIN))
    return c.json({ code: 'ORIGIN_REJECTED' }, 403);
  if (!/^room-([1-9]|1[0-6])$/.test(c.req.query('room') ?? ''))
    return c.json({ code: 'INVALID_ROOM' }, 400);

  await next();
};
