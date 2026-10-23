import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { unstable_dev } from 'wrangler';
import type { Env } from '../src/worker/env.ts';
import { scheduledD1 } from '../src/worker/scheduled.ts';
import { localD1 } from './local-d1.ts';
import { localOperationsConfig } from './local-operations-config.ts';

const runtime = parseEnv(readFileSync('.dev.vars', 'utf8'));
function setup() {
  if (existsSync('.env.erasure-local'))
    throw new Error('LOCAL_ERASURE_ALREADY_CONFIGURED');
  if (!runtime.CLERK_SECRET_KEY || !runtime.CLERK_PUBLISHABLE_KEY)
    throw new Error('AUTH_SECRET_KEY_REQUIRED');
  writeFileSync(
    '.env.erasure-local',
    [
      ...['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_JWT_KEY']
        .filter((name) => runtime[name])
        .map((name) => `${name}=${JSON.stringify(runtime[name])}`),
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Local private maintenance configured. Restart the app.');
}
async function run(action: string) {
  const values = localOperationsConfig(runtime);
  if (!values) throw new Error('LOCAL_ERASURE_CONFIGURATION_REQUIRED');
  const config = resolve(`.wrangler/local-maintenance-${crypto.randomUUID()}.json`);
  const entry = resolve(`.wrangler/local-maintenance-${crypto.randomUUID()}.ts`);
  const source = JSON.parse(readFileSync('wrangler.erasure.jsonc', 'utf8'));
  const gameConfig = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  writeFileSync(
    entry,
    "export { GameRoom, Matchmaker, Probe } from '../src/worker/index.ts';\nexport { default } from '../src/erasure/index.ts';\n",
  );
  writeFileSync(
    config,
    JSON.stringify({
      ...source,
      name: gameConfig.name,
      main: entry,
      migrations: gameConfig.migrations,
      services: [{ binding: 'ACCOUNT_ERASURE', service: gameConfig.name }],
      durable_objects: {
        bindings: source.durable_objects.bindings.map(
          ({ name, class_name }: { name: string; class_name: string }) => ({
            name,
            class_name,
          }),
        ),
      },
      d1_databases: source.d1_databases.map((binding: Record<string, unknown>) => ({
        ...binding,
        migrations_dir: resolve('drizzle-d1'),
      })),
    }),
  );
  let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
  const database = await localD1();
  try {
    // Share the original namespace in one local runtime; no cross-server registry is needed.
    worker = await unstable_dev(entry, {
      config,
      vars: { ...runtime, ...values },
      envFiles: [],
      local: true,
      ip: '127.0.0.1',
      port: 0,
      inspectorPort: 0,
      persist: true,
      persistTo: resolve('.wrangler/state'),
      logLevel: 'none',
      experimental: {
        watch: false,
        showInteractiveDevSession: false,
        disableDevRegistry: true,
      },
    });
    if (action === 'maintenance') {
      const service = worker;
      const maintenanceEnv = {
        ...runtime,
        GAME_D1: database.binding,
        ACCOUNT_ERASURE: {
          fetch: (input: RequestInfo | URL, init?: RequestInit) =>
            service.fetch(String(input), {
              method: init?.method,
              headers: init?.headers
                ? Array.from(new Headers(init.headers).entries())
                : undefined,
              body: typeof init?.body === 'string' ? init.body : undefined,
              signal: AbortSignal.timeout(30000),
            }),
        },
        ...values,
      } as unknown as Env;
      await scheduledD1(maintenanceEnv, Date.now(), 'hourly');
      await scheduledD1(maintenanceEnv, Date.now(), 'daily');
    } else {
      const response = await worker.fetch(`/${action}`, {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
      });
      const value = (await response.json()) as { ready?: boolean; code?: string };
      if (
        (!response.ok && !(response.status === 503 && value.ready === false)) ||
        value.code
      )
        throw new Error(
          value.code && /^[A-Z_]+$/.test(value.code)
            ? value.code
            : 'LOCAL_OPERATIONS_INCOMPLETE',
        );

      if (action === 'status') console.log(value);
    }
    if (action !== 'status') console.log(`Local ${action} batch completed.`);
  } finally {
    await worker?.stop();
    await database.close();
    unlinkSync(config);
    unlinkSync(entry);
  }
}
try {
  const action = process.argv[2];
  if (action === 'setup') setup();
  else if (['maintenance', 'status'].includes(action)) await run(action);
  else throw new Error('Use setup, maintenance, or status');
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(/^[A-Z_]+$/.test(message) ? message : 'LOCAL_OPERATIONS_FAILED');
  process.exitCode = 1;
}
