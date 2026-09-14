import type { ErrorHandler, Handler, NotFoundHandler } from 'hono';
import type { Env } from '../env';

export const health: Handler<{ Bindings: Env }> = (c) =>
  c.json({ ok: true, stage: '0A/0B' });

export const notFound: NotFoundHandler<{ Bindings: Env }> = (c) =>
  c.json({ code: 'NOT_FOUND' }, 404);

export const handleError: ErrorHandler<{ Bindings: Env }> = (_error, c) =>
  c.json(
    {
      code: c.req.path.startsWith('/api/matchmaking/')
        ? 'MATCH_UNAVAILABLE'
        : 'PROBE_FAILED',
      correlationId: crypto.randomUUID(),
    },
    500,
  );
