import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const account = 'cb60779f06e19f44410227423dd55e41';
export function usageDiagnostics(response, result) {
  const ray = response.headers.get('cf-ray');
  const retryAfter = response.headers.get('retry-after');
  return {
    status: response.status,
    rayId: typeof ray === 'string' && /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray) ? ray : null,
    errorRayIds: Array.isArray(result?.errors)
      ? [
          ...new Set(
            result.errors
              .map((error) => error?.extensions?.ray_id)
              .filter(
                (value) =>
                  typeof value === 'string' && /^[a-f0-9]{16}-[A-Z]{3}$/.test(value),
              ),
          ),
        ]
      : [],
    retryAfterSeconds:
      typeof retryAfter === 'string' && /^\d{1,8}$/.test(retryAfter)
        ? Number(retryAfter)
        : null,
    // Retain only documented codes; server messages can contain private input.
    budgetRejected:
      Array.isArray(result?.errors) &&
      result.errors.some((error) => error?.extensions?.code === 'budget'),
  };
}
export function usageQueryError(status, errors) {
  // Classify known API diagnostics without retaining messages, query text or credentials.
  const messages = JSON.stringify(errors ?? []);
  const code = /budget/i.test(messages)
    ? 'RATE_LIMIT_BUDGET'
    : /excessive resources/i.test(messages)
      ? 'RATE_LIMIT_RESOURCES'
      : /too many nodes, zones and accounts/i.test(messages)
        ? 'RATE_LIMIT_QUERY_NODES'
        : status === 429 || /rate.limit/i.test(messages)
          ? 'RATE_LIMIT'
          : /auth|token|permission|access/i.test(messages)
            ? 'AUTHORIZATION'
            : /limit|filter|argument|query/i.test(messages)
              ? 'QUERY'
              : 'API_ERROR';
  return Object.assign(
    new Error(`Cloudflare usage query failed: HTTP ${status} ${code}`),
    { code },
  );
}
async function refreshAuthentication() {
  // Capture CLI output so account details and credentials never enter the report.
  try {
    await promisify(execFile)(
      process.execPath,
      ['node_modules/wrangler/bin/wrangler.js', 'whoami'],
      { timeout: 20000, windowsHide: true },
    );
  } catch {
    throw new Error('Cloudflare authentication refresh failed; run Wrangler whoami');
  }
}
export async function cloudUsage() {
  const credentialPath = path.join(
    process.env.APPDATA,
    'xdg.config/.wrangler/config/default.toml',
  );
  let authentication = await readFile(credentialPath, 'utf8');
  const expiration = /^expiration_time\s*=\s*"([^"\r\n]+)"/m.exec(authentication)?.[1];
  if (expiration && Date.parse(expiration) <= Date.now() + 60000) {
    // Let Wrangler refresh its existing login; never handle or print refresh tokens.
    await refreshAuthentication();
    authentication = await readFile(credentialPath, 'utf8');
  }
  let token = /^oauth_token\s*=\s*"([^"\r\n]+)"/m.exec(authentication)?.[1];
  if (!token)
    throw new Error('Cloudflare authentication unavailable; refresh Wrangler login');
  const date = new Date().toISOString().slice(0, 10),
    // No dimensions: each dataset returns a single account-wide aggregate.
    filter = `limit: 1, filter: {date_geq: "${date}", date_leq: "${date}"}`,
    d1Filter = `limit: 1, filter: {datetimeHour_geq: "${date}T00:00:00Z", datetimeHour_leq: "${new Date().toISOString()}"}`,
    query = `{ viewer { accounts(filter: {accountTag: "${account}"}) {
      d1AnalyticsAdaptiveGroups(${d1Filter}) { sum { rowsRead rowsWritten } }
      durableObjectsInvocationsAdaptiveGroups(${d1Filter}) { sum { requests errors } }
      durableObjectsPeriodicGroups(${d1Filter}) { sum { duration rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors fatalInternalErrors } }
      workersInvocationsAdaptive(${filter}) { sum { requests errors } }
    } } }`;
  let result;
  const diagnostics = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = {
      attempt: attempt + 1,
      rateLimitMode: 'account-based',
      startedAt: new Date().toISOString(),
    };
    diagnostics.push(request);
    try {
      const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Rate-Limit-Type': request.rateLimitMode,
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(12000),
      });
      Object.assign(request, usageDiagnostics(response, null));
      try {
        result = await response.json();
      } catch (error) {
        // A throttled response may be HTML or empty; do not retry its parse failure.
        if (response.status === 429) throw usageQueryError(response.status, []);
        throw error;
      }
      Object.assign(request, usageDiagnostics(response, result));
      if (!response.ok || result.errors?.length) {
        if (response.status === 401 && attempt < 2) {
          // whoami can reuse a nearly expired token; refresh again after actual rejection.
          await refreshAuthentication();
          authentication = await readFile(credentialPath, 'utf8');
          token = /^oauth_token\s*=\s*"([^"\r\n]+)"/m.exec(authentication)?.[1];
          if (!token) throw new Error('Cloudflare authentication unavailable');
        }
        throw usageQueryError(response.status, result.errors);
      }
      break;
    } catch (error) {
      request.failure = error.message.startsWith('Cloudflare usage query failed:')
        ? error.code
        : 'REQUEST_FAILED';
      if (error.code?.startsWith('RATE_LIMIT') || attempt === 2)
        throw Object.assign(
          new Error(
            `Cloudflare usage unavailable after ${attempt + 1} attempts (${error.message.startsWith('Cloudflare usage query failed:') ? error.message : error.name})`,
          ),
          { diagnostics },
        );
    } finally {
      request.finishedAt = new Date().toISOString();
    }
    await pause(3000);
  }
  const data = result.data?.viewer?.accounts?.[0];
  if (!data)
    throw Object.assign(new Error('Cloudflare usage unavailable'), { diagnostics });
  const sum = (groups, fields) =>
    Object.fromEntries(
      fields.map((field) => [
        field,
        groups.reduce((total, group) => total + group.sum[field], 0),
      ]),
    );
  return {
    checkedAt: new Date().toISOString(),
    utcDate: date,
    analytics: { diagnostics },
    d1: sum(data.d1AnalyticsAdaptiveGroups, ['rowsRead', 'rowsWritten']),
    workers: sum(data.workersInvocationsAdaptive, ['requests', 'errors']),
    durableObjects: {
      ...sum(data.durableObjectsInvocationsAdaptiveGroups, ['requests', 'errors']),
      ...sum(data.durableObjectsPeriodicGroups, [
        'duration',
        'rowsRead',
        'rowsWritten',
        'exceededCpuErrors',
        'exceededMemoryErrors',
        'fatalInternalErrors',
      ]),
    },
  };
}
export function assertFreeBudget(usage) {
  for (const [group, field, limit] of [
    ['d1', 'rowsRead', 5000000],
    ['d1', 'rowsWritten', 100000],
    ['workers', 'requests', 100000],
    ['durableObjects', 'requests', 100000],
    ['durableObjects', 'duration', 13000],
    ['durableObjects', 'rowsRead', 5000000],
    ['durableObjects', 'rowsWritten', 100000],
  ])
    if (!Number.isFinite(usage[group][field]) || usage[group][field] >= limit * 0.8)
      throw new Error(`Free budget stop: ${group}.${field}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  try {
    console.log(JSON.stringify(await cloudUsage()));
  } catch (error) {
    console.error(
      JSON.stringify({ message: error.message, diagnostics: error.diagnostics }),
    );
    process.exitCode = 1;
  }
