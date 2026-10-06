import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';

export const authorizeLocalGame: MiddlewareHandler<{ Bindings: Env }> = async (
  context,
  next,
) => {
  context.header('Cache-Control', 'no-store');
  // Viteの本番ビルドでは常にfalse。公開Workerのvarsだけでは有効化できない。
  if (!import.meta.env.DEV || context.env.LOCAL_GAME_ENABLED !== 'true')
    return context.json({ code: 'LOCAL_GAME_DISABLED' }, 404);

  const origin = context.req.header('Origin');
  const url = new URL(context.req.url);
  if (!origin || (origin !== url.origin && origin !== context.env.PROBE_ORIGIN))
    return context.json({ code: 'ORIGIN_REJECTED' }, 403);
  if (!/^room-([1-9]|1[0-6])$/.test(context.req.query('room') ?? ''))
    return context.json({ code: 'INVALID_ROOM' }, 400);

  await next();
};
