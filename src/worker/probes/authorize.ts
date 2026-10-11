import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.ts';

export const authorizeProbe: MiddlewareHandler<{ Bindings: Env }> = async (
  context,
  next,
) => {
  context.header('Cache-Control', 'no-store');

  if (
    context.env.PROBES_ENABLED !== 'true' ||
    !context.env.PROBE_TOKEN ||
    context.env.PROBE_TOKEN.length < 32
  )
    return context.json({ code: 'PROBES_DISABLED' }, 404);

  const expected = new TextEncoder().encode(`Bearer ${context.env.PROBE_TOKEN}`);
  const supplied = new TextEncoder().encode(context.req.header('Authorization') ?? '');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return context.json({ code: 'UNAUTHORIZED' }, 401);

  const requestOrigin = context.req.header('Origin');
  if (
    requestOrigin &&
    requestOrigin !== new URL(context.req.url).origin &&
    requestOrigin !== context.env.PROBE_ORIGIN
  )
    return context.json({ code: 'ORIGIN_REJECTED' }, 403);

  await next();
};
