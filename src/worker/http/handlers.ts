import type { Context, Handler } from 'hono';
import type { Env } from '../env.ts';
import { OrganizationError } from '../organization/access.ts';

export const health: Handler<{ Bindings: Env }> = (context) => context.json({ ok: true });

export function notFound<Runtime extends { Bindings: Env }>(context: Context<Runtime>) {
  return context.json({ code: 'NOT_FOUND' }, 404);
}

// Only fixed categories or database identifiers; never SQL, bindings or personal data.
export function failureCode(error: unknown): string {
  if (typeof error === 'string') return failureCode(new Error(error));
  if (!(error instanceof Error)) return 'INTERNAL';
  if (/^[A-Z][A-Z0-9_]{2,79}$/.test(error.message)) return error.message;
  for (const [pattern, code] of [
    [/too many.*subrequests/i, 'REQUEST_LIMIT'],
    [/too many SQL variables/i, 'D1_PARAMETERS'],
    [/Wrong number of parameter bindings/i, 'D1_BINDINGS'],
    [/FOREIGN KEY constraint failed/i, 'D1_FOREIGN_KEY'],
    [/UNIQUE constraint failed/i, 'D1_UNIQUE'],
    [/NOT NULL constraint failed/i, 'D1_NOT_NULL'],
    [/CHECK constraint failed/i, 'D1_CHECK'],
    [/expression tree is too large/i, 'D1_EXPRESSION_DEPTH'],
    [/syntax error/i, 'D1_SYNTAX'],
    [/parser stack overflow/i, 'D1_PARSER_STACK'],
    [/daily quota.*(?:Read|Written|Write)/i, 'D1_DAILY_QUOTA'],
    [/Query timeout|query timed out/i, 'D1_QUERY_TIMEOUT'],
    [/Too many requests|overloaded/i, 'SERVICE_BUSY'],
    [/exceeded.*(?:CPU|cpu)/, 'CPU_LIMIT'],
    [/SQLITE_AUTH|not authorized/i, 'D1_AUTH'],
    [/database is locked|database is busy/i, 'D1_BUSY'],
    [/Network connection lost|connection reset/i, 'NETWORK_UNAVAILABLE'],
  ] as const)
    if (pattern.test(error.message)) return code;
  const databaseCode = /D1_ERROR: ([A-Z][A-Z0-9_]{2,79})(?:\b|:)/.exec(
    error.message,
  )?.[1];
  if (databaseCode) return databaseCode;
  const missing = /no such (table|column|function): ([a-z_][a-z0-9_]{0,60})/i.exec(
    error.message,
  );
  if (missing)
    return `D1_MISSING_${missing[1].toUpperCase()}_${missing[2].toUpperCase()}`;
  return error.cause
    ? failureCode(error.cause)
    : ({ TypeError: 'TYPE_ERROR', RangeError: 'RANGE_ERROR' }[error.name] ?? 'INTERNAL');
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
      code: failureCode(error),
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
