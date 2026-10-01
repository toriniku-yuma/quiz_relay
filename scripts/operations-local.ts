import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { sql } from 'drizzle-orm';
import { unstable_dev } from 'wrangler';
import { connectDatabase } from '../src/worker/db/connection.ts';
import { localOperationsConfig } from './local-operations-config.ts';

const runtime = parseEnv(readFileSync('.dev.vars', 'utf8'));
async function setup() {
  if (existsSync('.env.erasure-local'))
    throw new Error('LOCAL_ERASURE_ALREADY_CONFIGURED');
  const local = parseEnv(readFileSync('.env.postgres-local', 'utf8'));
  const url = new URL(local.GAME_MIGRATION_DATABASE_URL ?? '');
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55432' ||
    url.pathname !== '/quiz_relay_dev' ||
    url.username !== 'postgres' ||
    url.search !== '?sslmode=disable'
  )
    throw new Error('NOT_LOCAL_DATABASE');
  const auth = new URL(runtime.SUPABASE_URL ?? '');
  let key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key && process.argv.includes('--read-existing-key')) {
    if (auth.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(auth.hostname))
      throw new Error('AUTH_PROJECT_REQUIRED');
    const admin = parseEnv(readFileSync('.env.supabase-admin', 'utf8'));
    if (!admin.SUPABASE_ACCESS_TOKEN) throw new Error('MANAGEMENT_TOKEN_REQUIRED');
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${auth.hostname.split('.')[0]}/api-keys?reveal=true`,
      {
        headers: { Authorization: `Bearer ${admin.SUPABASE_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error('AUTH_KEY_READ_FAILED');
    const keys = (await response.json()) as {
      api_key?: string;
      name?: string;
      type?: string;
    }[];
    key =
      keys.find(
        (item) => item.type === 'secret' && item.api_key?.startsWith('sb_secret_'),
      )?.api_key ?? keys.find((item) => item.name === 'service_role')?.api_key;
  }
  if (!key) throw new Error('AUTH_SECRET_KEY_REQUIRED');
  const password = Buffer.from(randomBytes(24)).toString('hex');
  const { db, close } = connectDatabase(url.toString());
  try {
    const [command] = await db.execute<{ ddl: string }>(
      sql`select format('ALTER ROLE quiz_erasure LOGIN PASSWORD %L', ${password}::text) as ddl`,
    );
    await db.execute(sql.raw(command.ddl));
  } finally {
    await close();
  }
  url.username = 'quiz_erasure';
  url.password = password;
  writeFileSync(
    '.env.erasure-local',
    [
      `ERASURE_DATABASE_URL=${url.toString()}`,
      `SUPABASE_URL=${auth.origin}`,
      `SUPABASE_SECRET_KEY=${key}`,
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    'Local erasure configured. Restart pnpm dev; no deployment or cloud Cron was changed.',
  );
}
async function run(action: string) {
  const values = localOperationsConfig(runtime);
  if (!values) throw new Error('LOCAL_ERASURE_CONFIGURATION_REQUIRED');
  const config = resolve(`.wrangler/local-maintenance-${crypto.randomUUID()}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync('wrangler.erasure.jsonc', 'utf8')),
      name: `quiz-relay-local-maintenance-${crypto.randomUUID()}`,
      main: resolve('src/erasure/index.ts'),
    }),
  );
  // A separate loopback-only caller reaches the running app's DOs through Wrangler's dev registry.
  let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
  try {
    worker = await unstable_dev(resolve('src/erasure/index.ts'), {
      config,
      vars: values,
      envFiles: [],
      local: true,
      ip: '127.0.0.1',
      port: 0,
      inspectorPort: 0,
      persist: false,
      logLevel: 'none',
      experimental: { watch: false, showInteractiveDevSession: false },
    });
    let more = false;
    do {
      const response = await worker.fetch(`/${action}`, { method: 'POST' });
      if (!response.ok) throw new Error('LOCAL_OPERATIONS_INCOMPLETE');
      const value = (await response.json()) as { ready?: boolean };
      more = action === 'inventory' && value.ready === false;
      if (more) console.log('Local inventory page completed; continuing.');
      else if (action === 'status') console.log(value);
    } while (more);
    if (action !== 'status') console.log(`Local ${action} batch completed.`);
  } finally {
    await worker?.stop();
    unlinkSync(config);
  }
}
try {
  const action = process.argv[2];
  if (action === 'setup') await setup();
  else if (['inventory', 'maintenance', 'status'].includes(action)) await run(action);
  else
    throw new Error('Use setup [--read-existing-key], inventory, maintenance, or status');
} catch (error) {
  // Driver errors and Auth payloads can contain credentials; only known action codes leave this CLI.
  const message = error instanceof Error ? error.message : '';
  console.error(/^[A-Z_]+$/.test(message) ? message : 'LOCAL_OPERATIONS_FAILED');
  process.exitCode = 1;
}
