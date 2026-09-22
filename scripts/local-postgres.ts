import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const root = resolve('.wrangler/postgres-dev');
const bin = resolve(process.env.LOCAL_PG_BIN ?? '.wrangler/pg-local/pgsql/bin');
const data = resolve(root, 'data');
const envFile = '.env.postgres-local';
const database = 'quiz_relay_dev';
const port = '55432';
const roles: Record<string, string> = {
  GAME_MIGRATION_DATABASE_URL: 'postgres',
  DATABASE_URL: 'quiz_probe',
  GAME_DATABASE_URL: 'quiz_game_reader',
  RESULT_DATABASE_URL: 'quiz_game_results',
  ORGANIZATION_DATABASE_URL: 'quiz_organization',
  GAME_CONFIG_DATABASE_URL: 'quiz_game_config',
  GAME_CATALOG_DATABASE_URL: 'quiz_game_catalog',
};
function config() {
  const values = parseEnv(readFileSync(envFile, 'utf8')) as Record<string, string>;
  for (const [key, role] of Object.entries(roles)) {
    const url = new URL(values[key]);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, port);
    assert.equal(url.pathname, `/${database}`);
    assert.equal(url.username, role);
    assert.equal(url.search, '?sslmode=disable');
  }
  return values;
}
function run(name: string, args: string[]) {
  return execFileSync(resolve(bin, `${name}.exe`), args, {
    windowsHide: true,
    timeout: 60000,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}
function running() {
  try {
    run('pg_ctl', ['-D', data, 'status']);
    return true;
  } catch {
    return false;
  }
}
async function start() {
  if (!existsSync(resolve(data, 'PG_VERSION')))
    throw new Error('Run pnpm db:local:setup first');
  if (running()) return;
  const child = spawn(
    resolve(bin, 'pg_ctl.exe'),
    ['-D', data, '-l', resolve(root, 'server.log'), '-w', 'start'],
    { windowsHide: true, detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      run('pg_isready', ['-h', '127.0.0.1', '-p', port]);
      if (running()) return;
    } catch {
      /* Wait for this cluster, not another server. */
    }
    await delay(200);
  }
  throw new Error('LOCAL_POSTGRES_START_FAILED');
}
function connect(address: string) {
  return postgres(address, { ssl: false, max: 1, prepare: false, connect_timeout: 5 });
}
async function setup() {
  mkdirSync(root, { recursive: true });
  if (!existsSync(envFile)) {
    if (existsSync(resolve(data, 'PG_VERSION')))
      throw new Error('LOCAL_CREDENTIALS_MISSING');
    const values = Object.entries(roles).map(
      ([key, role]) =>
        `${key}=postgres://${role}:${Array.from(randomBytes(24), (byte) => byte.toString(16).padStart(2, '0')).join('')}@127.0.0.1:${port}/${database}?sslmode=disable`,
    );
    writeFileSync(envFile, `${values.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  }
  const values = config();
  if (!existsSync(resolve(data, 'PG_VERSION'))) {
    const passwordFile = resolve(root, 'init-password');
    writeFileSync(passwordFile, new URL(values.GAME_MIGRATION_DATABASE_URL).password, {
      mode: 0o600,
    });
    run('initdb', [
      '-D',
      data,
      '-U',
      'postgres',
      '--encoding=UTF8',
      '--locale=C',
      '--auth=scram-sha-256',
      `--pwfile=${passwordFile}`,
    ]);
    const settings = resolve(data, 'postgresql.conf');
    writeFileSync(
      settings,
      `${readFileSync(settings, 'utf8')}\nlisten_addresses = '127.0.0.1'\nport = ${port}\n`,
    );
  }
  await start();
  const adminUrl = new URL(values.GAME_MIGRATION_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const cluster = connect(adminUrl.toString());
  try {
    const existing = await cluster`select 1 from pg_database where datname = ${database}`;
    if (!existing.length) await cluster`create database quiz_relay_dev`;
    for (const role of ['anon', 'authenticated']) {
      const found = await cluster`select 1 from pg_roles where rolname = ${role}`;
      if (!found.length)
        await cluster.unsafe(
          role === 'anon'
            ? 'CREATE ROLE anon NOLOGIN'
            : 'CREATE ROLE authenticated NOLOGIN',
        );
    }
  } finally {
    await cluster.end();
  }
  const client = connect(values.GAME_MIGRATION_DATABASE_URL);
  try {
    await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
    for (const [key, role] of Object.entries(roles)) {
      if (role === 'postgres') continue;
      const password = decodeURIComponent(new URL(values[key]).password);
      const [command] =
        await client`select format('ALTER ROLE %I PASSWORD %L', ${role}::text, ${password}::text) as ddl`;
      await client.unsafe(command.ddl);
    }
  } finally {
    await client.end();
  }
  const current = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8') : '';
  const backup = resolve(root, 'dev-vars-before-local');
  if (!existsSync(backup)) writeFileSync(backup, current, { flag: 'wx', mode: 0o600 });
  let updated = current;
  const runtime = {
    DATABASE_URL: values.DATABASE_URL,
    GAME_DATABASE_URL: values.GAME_DATABASE_URL,
    RESULT_DATABASE_URL: values.RESULT_DATABASE_URL,
    ORGANIZATION_DATABASE_URL: values.ORGANIZATION_DATABASE_URL,
    ORGANIZATION_ENABLED: 'true',
    GAME_CONFIG_PROFILE: 'local',
  };
  for (const [key, value] of Object.entries(runtime)) {
    const pattern = new RegExp(`^${key}=.*$`, 'gm');
    updated = pattern.test(updated)
      ? updated.replace(pattern, `${key}=${value}`)
      : `${updated.trimEnd()}\n${key}=${value}\n`;
  }
  const original = parseEnv(current);
  const revised = parseEnv(updated);
  for (const key of [
    'SUPABASE_URL',
    'SUPABASE_PUBLISHABLE_KEY',
    'INITIAL_ADMIN_SUBJECT',
    'DEV_TLS_CERT',
    'DEV_TLS_KEY',
  ])
    assert.equal(revised[key], original[key]);
  writeFileSync('.dev.vars', updated, { mode: 0o600 });
  console.log(
    'Local PostgreSQL ready at 127.0.0.1:55432/quiz_relay_dev; existing data and Supabase Auth settings preserved',
  );
}
async function check() {
  const values = config();
  for (const [key, role] of Object.entries(roles)) {
    const client = connect(values[key]);
    try {
      assert.equal((await client`select current_user`)[0].current_user, role);
      if (role === 'quiz_game_reader') {
        await client`select count(*) from quiz_game.question_versions`;
        await assert.rejects(
          client.begin(async (tx) => {
            await tx`delete from quiz_game.question_versions`;
            // Roll back even when an incorrect grant allows the forbidden operation.
            throw new Error('READER_DELETE_WAS_ALLOWED');
          }),
          (e: unknown) => (e as { code: string }).code === '42501',
        );
      }
      if (role === 'quiz_organization') {
        await client`select count(*) from quiz_game.organizations`;
        await assert.rejects(
          client`select * from quiz_game.match_results`,
          (e: unknown) => (e as { code: string }).code === '42501',
        );
      }
      if (role === 'quiz_probe') {
        const rollback = new Error('ROLLBACK');
        await assert.rejects(
          client.begin(async (tx) => {
            const id = crypto.randomUUID();
            await tx`insert into quiz_probe.runs (id) values (${id})`;
            assert.equal(
              (await tx`select id from quiz_probe.runs where id=${id}`).length,
              1,
            );
            throw rollback;
          }),
          (e) => e === rollback,
        );
      }
    } finally {
      await client.end();
    }
  }
  console.log('PASS: 7 dedicated logins, read/write rollback and permission boundaries');
}
async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !['setup', 'start', 'stop', 'check'].includes(command))
    throw new Error('Use setup/start/stop/check');
  if (!existsSync(resolve(bin, 'pg_ctl.exe')))
    throw new Error('POSTGRES_BINARIES_REQUIRED: set LOCAL_PG_BIN');
  if (command === 'setup') await setup();
  if (command === 'start') {
    const local = config();
    const runtime = parseEnv(readFileSync('.dev.vars', 'utf8'));
    if (runtime.ORGANIZATION_ENABLED !== 'true') {
      console.error(
        'Local organization setup is disabled; run pnpm db:local:setup, then restart pnpm dev',
      );
      process.exitCode = 1;
      return;
    }
    for (const key of [
      'DATABASE_URL',
      'GAME_DATABASE_URL',
      'RESULT_DATABASE_URL',
      'ORGANIZATION_DATABASE_URL',
    ]) {
      if (runtime[key] !== local[key]) {
        console.error(
          `${key} differs from local configuration; run pnpm db:local:setup, then restart pnpm dev`,
        );
        process.exitCode = 1;
        return;
      }
    }
    await start();
    console.log('Local PostgreSQL running');
  }
  if (command === 'stop') {
    if (running()) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    console.log('Local PostgreSQL stopped; data retained');
  }
  if (command === 'check') await check();
}
main().catch((error: unknown) => {
  console.error('LOCAL_POSTGRES_FAILED', error instanceof Error ? error.name : 'unknown');
  process.exitCode = 1;
});
