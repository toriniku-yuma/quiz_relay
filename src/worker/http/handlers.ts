import type { Context, Handler } from 'hono';
import type { Env } from '../env.ts';
import { OrganizationError } from '../organization/access.ts';
import { failureDetails } from './diagnostics.ts';

export const health: Handler<{ Bindings: Env }> = (context) => context.json({ ok: true });

export function notFound<Runtime extends { Bindings: Env }>(context: Context<Runtime>) {
  return context.json({ code: 'NOT_FOUND' }, 404);
}

export function handleError<Runtime extends { Bindings: Env }>(
  error: Error,
  context: Context<Runtime>,
) {
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
      ...failureDetails(error),
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
}
