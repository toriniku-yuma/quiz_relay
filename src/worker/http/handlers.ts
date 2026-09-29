import type { ErrorHandler, Handler, NotFoundHandler } from 'hono';
import type { Env } from '../env';
import { OrganizationError } from '../organization/access';

export const health: Handler<{ Bindings: Env }> = (c) =>
  c.json({ ok: true, stage: '0A/0B' });

export const notFound: NotFoundHandler<{ Bindings: Env }> = (c) =>
  c.json({ code: 'NOT_FOUND' }, 404);

export const handleError: ErrorHandler<{ Bindings: Env }> = (error, c) => {
  if (error instanceof OrganizationError)
    return c.json(
      { code: error.code, ...(error.target ? { target: error.target } : {}) },
      error.status,
    );
  const correlationId = crypto.randomUUID();
  const operation = c.req.path.startsWith('/api/organization/')
    ? 'organization'
    : c.req.path.startsWith('/api/results/')
      ? 'results'
      : c.req.path.startsWith('/api/matchmaking/')
        ? 'matchmaking'
        : 'other';
  console.error(
    JSON.stringify({
      event: 'request_failed',
      operation,
      correlationId,
      type: error.name === 'PostgresError' ? 'database' : 'internal',
    }),
  );
  return c.json(
    {
      code: c.req.path.startsWith('/api/matchmaking/')
        ? 'MATCH_UNAVAILABLE'
        : c.req.path.startsWith('/api/organization/')
          ? 'ORGANIZATION_UNAVAILABLE'
          : c.req.path.startsWith('/api/results/')
            ? 'RESULTS_UNAVAILABLE'
            : 'PROBE_FAILED',
      correlationId,
    },
    500,
  );
};
