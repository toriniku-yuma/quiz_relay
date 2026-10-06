import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { contentHash } from '../src/worker/catalog/hash.ts';
import * as schema from '../src/worker/db/schema.ts';
import type { Env } from '../src/worker/env';
import { rules } from '../src/worker/game/rules.ts';
import {
  allowedInstanceActors,
  organizationIdentity,
  overview,
  resolveInstance,
  setInstanceGrants,
  setupOrganization,
} from '../src/worker/organization/database.ts';
import { commitResult } from '../src/worker/results/database.ts';
import { readResults } from '../src/worker/results/read.ts';
import type { ResultRecord } from '../src/worker/results/record.ts';

let phase = 'configuration';

async function main() {
  // No .env loading. Use a separate disposable cluster: committed fixtures remain for inspection.
  const address = process.env.LOCAL_ORGANIZATION_RECOVERY_DATABASE_URL;
  if (!address) throw new Error('LOCAL_RECOVERY_DATABASE_REQUIRED');
  const url = new URL(address);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.pathname, '/quiz_relay_organization_recovery');
  assert.equal(url.search, '');
  const options = { ssl: false as const, max: 1, prepare: false, connect_timeout: 5 };
  const admin = postgres(address, options);
  const clients = [admin];
  const db = drizzle(admin);
  try {
    assert.equal(
      (
        await admin`select 1 from pg_namespace where nspname in ('quiz_game','quiz_probe') union all select 1 from pg_roles where rolname like 'quiz_%'`
      ).length,
      0,
      'Use a fresh disposable cluster',
    );
    phase = 'migrations';
    await admin.begin(async (tx) => {
      await tx`create role anon`;
      await tx`create role authenticated`;
      const journal = JSON.parse(
        await readFile('drizzle/meta/_journal.json', 'utf8'),
      ) as { entries: { tag: string }[] };
      for (const { tag } of journal.entries) {
        const source = await readFile(`drizzle/${tag}.sql`, 'utf8');
        for (const statement of source.split('--> statement-breakpoint'))
          if (statement.trim()) await tx.unsafe(statement);
      }
    });
    phase = 'dedicated-login';
    const password = crypto.randomUUID();
    const [ddl] =
      await admin`select format('alter role quiz_organization password %L', ${password}::text) as statement`;
    await admin.unsafe(ddl.statement);
    const serviceUrl = new URL(address);
    serviceUrl.username = 'quiz_organization';
    serviceUrl.password = password;
    const first = postgres(serviceUrl.toString(), options);
    const second = postgres(serviceUrl.toString(), options);
    clients.push(first, second);
    const observer = postgres(address, options);
    clients.push(observer);
    const one = drizzle(first);
    const two = drizzle(second);
    assert.equal((await first`select current_user`)[0].current_user, 'quiz_organization');
    await assert.rejects(
      first`select * from quiz_game.match_results`,
      (error: unknown) => (error as { code: string }).code === '42501',
    );
    await assert.rejects(
      first`update quiz_game.organizations set identity_namespace = 'changed'`,
      (error: unknown) => (error as { code: string }).code === '42501',
    );

    phase = 'concurrency';
    const runtime = {
      GAME_OWNER: 'https://recovery.invalid',
      INITIAL_ADMIN_SUBJECT: 'installer',
    } as Env;
    let unlock = () => {};
    let locked = () => {};
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const holder = admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(716329410)`;
      locked();
      await release;
    });
    await Promise.race([
      ready,
      holder.then(() => {
        throw new Error('LOCK_NOT_HELD');
      }),
    ]);
    const requests = Promise.allSettled(
      [one, two].map((connection, index) =>
        setupOrganization(connection, runtime, 'installer', {
          name: `Organization ${index}`,
          instanceName: 'Original',
        }),
      ),
    );
    try {
      const deadline = Date.now() + 10000;
      while (true) {
        const waiting =
          await observer`select 1 from pg_locks where locktype = 'advisory' and classid = 0 and objid = 716329410 and not granted`;
        if (waiting.length === 2) break;
        if (Date.now() > deadline) throw new Error('CONCURRENT_REQUESTS_NOT_BLOCKED');
        await delay(25);
      }
    } finally {
      unlock();
      await holder;
    }
    const results = await requests;
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(
      results.filter(
        (result) =>
          result.status === 'rejected' && result.reason.code === 'ALREADY_CONFIGURED',
      ).length,
      1,
    );
    assert.equal((await db.select().from(schema.organizations)).length, 1);
    assert.equal((await db.select().from(schema.organizationAccounts)).length, 1);
    const instance = (await overview(one, 'installer')).instances[0];
    const actor = (await organizationIdentity(one, 'player')).account.actorId;
    const grants = await Promise.allSettled([
      setInstanceGrants(one, 'installer', {
        id: instance.id,
        actorId: actor,
        expected: '',
        permissions: ['questions'],
      }),
      setInstanceGrants(two, 'installer', {
        id: instance.id,
        actorId: actor,
        expected: '',
        permissions: ['users'],
      }),
    ]);
    assert.equal(grants.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(
      grants.filter(
        (result) =>
          result.status === 'rejected' && result.reason.code === 'EDIT_CONFLICT',
      ).length,
      1,
    );
    console.log(
      'PASS: dedicated LOGIN permissions, competing bootstrap and grant updates',
    );

    phase = 'participation-access';
    const [storedInstance] = await db.select().from(schema.instances);
    const administrator = (await organizationIdentity(one, 'installer')).account.actorId;
    const ordinary = (await organizationIdentity(one, 'ordinary')).account.actorId;
    const scope = { id: instance.id, owner: storedInstance.owner };
    const accessUrl = new URL(serviceUrl);
    accessUrl.searchParams.set('sslmode', 'disable');
    const accessEnv = { ...runtime, ORGANIZATION_DATABASE_URL: accessUrl.href } as Env;
    assert.deepEqual(
      (
        await allowedInstanceActors(accessEnv, scope, [actor, administrator, ordinary])
      ).sort(),
      [actor, administrator].sort(),
    );
    assert.deepEqual(
      await allowedInstanceActors(accessEnv, { ...scope, owner: 'wrong' }, [actor]),
      [],
    );
    const previous = (await one.select().from(schema.instanceGrants)).map(
      (result) => result.permission,
    );
    await setInstanceGrants(one, 'installer', {
      id: instance.id,
      actorId: actor,
      expected: previous.sort().join(','),
      permissions: [],
    });
    assert.deepEqual(await allowedInstanceActors(accessEnv, scope, [actor]), []);
    // Existing sessions can still identify their own instance; ordinary reads remain forbidden.
    await assert.rejects(resolveInstance(one, 'player', instance.id));
    assert.equal(
      (await resolveInstance(one, 'player', instance.id, true)).account.actorId,
      actor,
    );
    await setInstanceGrants(one, 'installer', {
      id: instance.id,
      actorId: actor,
      expected: '',
      permissions: previous,
    });
    console.log(
      'PASS: preparing participation, scoped identity, grant removal and existing-session context',
    );

    phase = 'backup-restore';
    const owner = (await db.select().from(schema.instances))[0].owner;
    const record: ResultRecord = {
      version: 1,
      owner,
      matchId: crypto.randomUUID(),
      kind: 'ranked',
      startedAt: 1000,
      ratingVersion: 1,
      result: {
        id: crypto.randomUUID(),
        winnerId: actor,
        reason: 'target_reached',
        finishedAt: 2000,
      },
      definition: {
        competition: { owner, id: 'qa', version: 1 },
        ruleset: { owner, id: 'qa', version: 1 },
        questionSet: { owner, id: 'qa', version: 1 },
        rules: { ...rules, showSelections: true },
        rulesHash: await contentHash({ ...rules, showSelections: true }),
        manifestHash: 'b'.repeat(64),
        playersPerMatch: 2,
      },
      players: [actor, 'other'].map((id) => ({
        id,
        name: id,
        correct: id === actor ? 7 : 0,
        mistakes: 0,
        connected: true,
        disqualified: false,
        locked: false,
        ratingDelta: id === actor ? 20 : -20,
      })),
    };
    await commitResult(db, record);
    async function snapshot(client: typeof admin) {
      const tables =
        await client`select schemaname, tablename from pg_tables where schemaname in ('quiz_game','quiz_probe') order by schemaname, tablename`;
      const values = [];
      for (const table of tables) {
        const rows =
          await client`select row_to_json(t)::text as value from ${client(table.schemaname)}.${client(table.tablename)} t order by row_to_json(t)::text`;
        values.push({
          table: `${table.schemaname}.${table.tablename}`,
          count: rows.length,
          hash: await contentHash(rows),
        });
      }
      return values;
    }
    const before = await snapshot(admin);
    const history = await readResults(db, owner, actor);
    const pgBin = resolve(process.env.LOCAL_PG_BIN ?? '.wrangler/pg-local/pgsql/bin');
    const archive = resolve('.wrangler/organization-recovery.dump');
    const pgEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PGHOST: url.hostname,
      PGHOSTADDR:
        url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/[[\]]/g, ''),
      PGPORT: url.port,
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: url.pathname.slice(1),
      PGSSLMODE: 'disable',
    };
    delete pgEnv.PGSERVICE;
    delete pgEnv.PGSERVICEFILE;
    delete pgEnv.PGOPTIONS;
    const run = (name: string, args: string[]) =>
      execFileSync(join(pgBin, `${name}.exe`), args, {
        env: pgEnv,
        windowsHide: true,
        timeout: 30000,
        stdio: 'pipe',
      });
    run('pg_dump', ['--format=custom', '--file', archive]);
    // Fixed new database name; never overwrite or drop an existing database.
    await admin`create database quiz_relay_organization_restored`;
    run('pg_restore', [
      '--exit-on-error',
      '--dbname=quiz_relay_organization_restored',
      archive,
    ]);
    const restoredUrl = new URL(address);
    restoredUrl.pathname = '/quiz_relay_organization_restored';
    const restored = postgres(restoredUrl.toString(), options);
    clients.push(restored);
    assert.deepEqual(await snapshot(restored), before);
    assert.deepEqual(await readResults(drizzle(restored), owner, actor), history);
    const restoredServiceUrl = new URL(serviceUrl);
    restoredServiceUrl.pathname = restoredUrl.pathname;
    const restoredService = postgres(restoredServiceUrl.toString(), options);
    clients.push(restoredService);
    assert.deepEqual(
      await overview(drizzle(restoredService), 'installer'),
      await overview(one, 'installer'),
    );
    await assert.rejects(
      restoredService`select * from quiz_game.match_results`,
      (error: unknown) => (error as { code: string }).code === '42501',
    );
    await assert.rejects(
      restored`update quiz_game.organizations set identity_namespace = 'changed'`,
    );
    console.log(
      'PASS: pg_dump/pg_restore table hashes, history/rating, service permissions and immutable trigger',
    );
  } finally {
    await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
  }
}
main().catch((error: unknown) => {
  // Do not print connection strings, SQL parameters or pg_dump child-process environments.
  console.error(
    'ORGANIZATION_RECOVERY_FAILED',
    phase,
    error instanceof Error ? error.name : 'unknown',
  );
  process.exitCode = 1;
});
