import type { ErrorHandler, Handler, NotFoundHandler } from 'hono';
import type { Env } from '../env';
import { OrganizationError } from '../organization/access';

export const health: Handler<{ Bindings: Env }> = (context) =>
  context.json({ ok: true, stage: '0A/0B' });

export const notFound: NotFoundHandler<{ Bindings: Env }> = (context) =>
  context.json({ code: 'NOT_FOUND' }, 404);

export const handleError: ErrorHandler<{ Bindings: Env }> = (error, context) => {
  if (error instanceof OrganizationError)
    return context.json(
      { code: error.code, ...(error.target ? { target: error.target } : {}) },
      error.status,
    );
  const correlationId = crypto.randomUUID();
  const operation = context.req.path.startsWith('/api/organization/')
    ? 'organization'
    : context.req.path.startsWith('/api/results/')
      ? 'results'
      : context.req.path.startsWith('/api/matchmaking/')
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
  return context.json(
    {
      code: context.req.path.startsWith('/api/matchmaking/')
        ? 'MATCH_UNAVAILABLE'
        : context.req.path.startsWith('/api/organization/')
          ? 'ORGANIZATION_UNAVAILABLE'
          : context.req.path.startsWith('/api/results/')
            ? 'RESULTS_UNAVAILABLE'
            : 'PROBE_FAILED',
      correlationId,
    },
    500,
  );
};
