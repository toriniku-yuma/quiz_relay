import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';

export const authorizeProbe: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  c.header('Cache-Control', 'no-store');

  if (
    c.env.PROBES_ENABLED !== 'true' ||
    !c.env.PROBE_TOKEN ||
    c.env.PROBE_TOKEN.length < 32
  )
    return c.json({ code: 'PROBES_DISABLED' }, 404);

  const expected = new TextEncoder().encode(`Bearer ${c.env.PROBE_TOKEN}`);
  const supplied = new TextEncoder().encode(c.req.header('Authorization') ?? '');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return c.json({ code: 'UNAUTHORIZED' }, 401);

  const requestOrigin = c.req.header('Origin');
  if (
    requestOrigin &&
    requestOrigin !== new URL(c.req.url).origin &&
    requestOrigin !== c.env.PROBE_ORIGIN
  )
    return c.json({ code: 'ORIGIN_REJECTED' }, 403);

  await next();
};
