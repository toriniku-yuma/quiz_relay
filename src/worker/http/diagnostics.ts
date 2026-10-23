// Only fixed categories or database identifiers; never SQL, bindings or personal data.
export function failureCode(error: unknown): string {
  if (typeof error === 'string') return failureCode(new Error(error));
  if (!(error instanceof Error)) return 'INTERNAL';
  if (/^[A-Z][A-Z0-9_]{2,79}$/.test(error.message)) return error.message;
  for (const [pattern, code] of [
    [/Durable Object.*reset because its code was updated/i, 'DO_CODE_UPDATED'],
    [/Durable Object.*(?:no longer active|replaced)/i, 'DO_REPLACED'],
    [/Durable Object storage operation exceeded timeout/i, 'DO_STORAGE_TIMEOUT'],
    [
      /blockConcurrencyWhile.*(?:timed out|timeout)|(?:timed out|timeout).*blockConcurrencyWhile/i,
      'DO_CONCURRENCY_TIMEOUT',
    ],
    [/Durable Object.*(?:reset|broken)/i, 'DO_RESET'],
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

export function connectionId(request: Request) {
  const value = new URL(request.url).searchParams.get('connection');
  if (value === null) return crypto.randomUUID();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) return null;
  return value;
}

// Log only fixed classifications; exception messages can contain SQL or credentials.
export function failureDetails(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const errorType =
    error instanceof Error &&
    ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'DOMException'].includes(
      error.name,
    )
      ? error.name
      : 'UnknownError';
  // Keep code positions, never the message, function arguments, URLs or directory paths.
  const locations =
    error instanceof Error && typeof error.stack === 'string'
      ? error.stack
          .split('\n')
          .slice(1)
          .flatMap((line) => {
            const frame =
              /^\s+at .*?(?:\(|[/\\])([A-Za-z][A-Za-z0-9_.-]{0,79}\.(?:js|mjs|ts|tsx)):(\d{1,8}):(\d{1,8})\)?$/.exec(
                line,
              );
            return frame ? [`${frame[1]}:${frame[2]}:${frame[3]}`] : [];
          })
          .slice(0, 6)
      : [];
  const markers = [
    [/blockConcurrencyWhile/i, 'CONCURRENCY'],
    [/timed? out|timeout/i, 'TIMEOUT'],
    [/reset|broken/i, 'RESET'],
    [/no longer active|replaced|code was updated/i, 'REPLACED'],
    [/cancel|abort/i, 'CANCELED'],
    [/disconnect|connection lost|connection reset/i, 'DISCONNECTED'],
    [/storage|D1_|SQLITE/i, 'STORAGE'],
    [/overload|too many/i, 'OVERLOADED'],
  ] as const;
  return {
    code: failureCode(error),
    errorType,
    locations,
    markers: markers.filter(([pattern]) => pattern.test(message)).map(([, code]) => code),
    remote: error instanceof Error && 'remote' in error && error.remote === true,
    retryable: error instanceof Error && 'retryable' in error && error.retryable === true,
    overloaded:
      error instanceof Error && 'overloaded' in error && error.overloaded === true,
  };
}
