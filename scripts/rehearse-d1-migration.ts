import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import canonicalize from 'canonicalize';
import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { connectD1 } from '../src/worker/db/d1.ts';
import { connectDatabase } from './legacy-postgres/connection.ts';
import { installPostgresCopy, verifyPostgresCopy } from './legacy-postgres/copy.ts';
import * as sourceSchema from './legacy-postgres/schema.ts';

const hash = (value: unknown) =>
  createHash('sha256')
    .update(canonicalize(value) ?? '')
    .digest('hex');
const tableHash = (rows: Record<string, unknown>[]) =>
  hash(rows.map((row) => canonicalize(row)).sort());
let phase = 'source';
let diagnostics: string | undefined;

async function main() {
  if (process.argv.slice(2).join(' ') !== '--local')
    throw new Error('Use --local for a read-only backup and a new isolated D1 copy.');
  const values = parseEnv(readFileSync('.env.postgres-local', 'utf8'));
  const sourceAddress = values.GAME_MIGRATION_DATABASE_URL;
  if (!sourceAddress) throw new Error('LOCAL_SOURCE_REQUIRED');
  const address = new URL(sourceAddress ?? '');
  if (address.protocol !== 'postgresql:' && address.protocol !== 'postgres:')
    throw new Error('LOCAL_SOURCE_REQUIRED');
  if (
    address.hostname !== '127.0.0.1' ||
    address.port !== '55432' ||
    address.pathname !== '/quiz_relay_dev' ||
    address.username !== 'postgres' ||
    address.search !== '?sslmode=disable'
  )
    throw new Error('LOCAL_SOURCE_REQUIRED');
  const directory = resolve('.wrangler/d1-migration', randomUUID());
  mkdirSync(resolve('.wrangler/d1-migration'), { recursive: true });
  mkdirSync(directory, { recursive: false });
  diagnostics = resolve(directory, 'failure.txt');
  const source = connectDatabase(sourceAddress);
  let snapshot: { name: string; rows: Record<string, unknown>[]; hash: string }[];
  try {
    snapshot = await source.db.transaction(
      async (tx) => {
        const tables = [];
        for (const [name, table] of Object.entries(sourceSchema)) {
          if (!is(table, PgTable)) continue;
          const rows = (await tx.select().from(table)) as Record<string, unknown>[];
          tables.push({ name, rows, hash: tableHash(rows) });
        }
        return tables;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  } finally {
    await source.close();
  }
  const backup = JSON.stringify({ version: 1, tables: snapshot });
  phase = 'backup';
  writeFileSync(resolve(directory, 'backup.json'), backup, { flag: 'wx' });
  const backupHash = createHash('sha256').update(backup).digest('hex');
  writeFileSync(resolve(directory, 'backup.sha256'), `${backupHash}\n`, { flag: 'wx' });
  if (
    createHash('sha256')
      .update(readFileSync(resolve(directory, 'backup.json')))
      .digest('hex') !== backupHash
  )
    throw new Error('BACKUP_HASH_MISMATCH');

  // Reuse the installed test runtime; no extra database or cloud account is provisioned.
  const require = createRequire(
    realpathSync('node_modules/@cloudflare/vitest-plugin/package.json'),
  );
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare') as {
    convertV4MiniflareOptions(options: unknown): unknown;
    Miniflare: new (
      options: unknown,
    ) => {
      getD1Database(name: string): Promise<D1Database>;
      dispose(): Promise<void>;
    };
  };
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("isolated migration"); } }',
      compatibilityDate: '2026-09-08',
      d1Databases: { MIGRATION_D1: randomUUID() },
      resourcePersistencePath: resolve(directory, 'state/v3'),
    }),
  );
  try {
    phase = 'runtime';
    const binding = await runtime.getD1Database('MIGRATION_D1');
    const journal = JSON.parse(readFileSync('drizzle-d1/meta/_journal.json', 'utf8')) as {
      entries: { tag: string }[];
    };
    for (const entry of journal.entries) {
      phase = `migration:${entry.tag}`;
      const statements = readFileSync(`drizzle-d1/${entry.tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (let start = 0; start < statements.length; start += 40)
        await binding.batch(
          statements
            .slice(start, start + 40)
            .map((statement) => binding.prepare(statement)),
        );
    }
    const db = connectD1(binding);
    phase = 'copy';
    const plan = await installPostgresCopy(db, snapshot);
    phase = 'verify';
    await verifyPostgresCopy(db, plan);
    const verified = plan.ordered.map((item) => ({
      table: item.name,
      rows: item.rows.length,
      sourceHash: item.hash,
      targetHash: tableHash(item.rows),
    }));
    const report = {
      tables: verified,
      backupHash,
      verifiedRows: verified.reduce((sum, table) => sum + table.rows, 0),
      integrity: 'ok',
      sourceModified: false,
      cutover: false,
    };
    writeFileSync(
      resolve(directory, 'verification.json'),
      JSON.stringify(report, null, 2),
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        directory,
        tables: verified.length,
        rows: report.verifiedRows,
        backupVerified: true,
        copyVerified: true,
        sourceModified: false,
        cutover: false,
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

main().catch((error: unknown) => {
  // Query failures can contain personal data; keep those details out of terminal output.
  const code =
    error instanceof Error &&
    /^(LOCAL_SOURCE_REQUIRED|BACKUP_HASH_MISMATCH|MISSING_D1_TABLE:|CYCLIC_D1_DEPENDENCIES|COPY_MISMATCH:|D1_INTEGRITY_FAILURE)/.test(
      error.message,
    )
      ? error.message
      : 'D1_MIGRATION_REHEARSAL_FAILED';
  if (diagnostics && error instanceof Error)
    writeFileSync(
      diagnostics,
      `${error.stack ?? error.message}\n${error.cause instanceof Error ? error.cause.stack : ''}`,
      { flag: 'wx' },
    );
  console.error(JSON.stringify({ code, phase }));
  process.exitCode = 1;
});
