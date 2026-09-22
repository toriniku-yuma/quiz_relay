import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { authorizeCatalog } from '../src/worker/catalog/manage.ts';
import { connectDatabase } from '../src/worker/db/connection.ts';
import { catalogOperators, instances } from '../src/worker/db/schema.ts';
import { validId } from '../src/worker/organization/access.ts';

async function main() {
  const [value, flag, ...extra] = process.argv.slice(2);
  const id = validId(value);
  if (extra.length || (flag && flag !== '--apply')) throw new Error('INVALID_ARGUMENTS');
  const role = `quiz_catalog_${id.replaceAll('-', '')}`;
  const file = `.env.catalog.${id}`;
  if (!flag) {
    console.log(
      JSON.stringify({ instanceId: id, role, credentialsFile: file, applied: false }),
    );
    return;
  }
  if (!process.env.GAME_MIGRATION_DATABASE_URL || !process.env.GAME_DATABASE_URL)
    throw new Error('CONFIG_REQUIRED');
  const admin = connectDatabase(
    process.env.GAME_MIGRATION_DATABASE_URL,
    process.env.DATABASE_CA_CERT,
  );
  try {
    const [instance] = await admin.db
      .select()
      .from(instances)
      .where(eq(instances.id, id));
    if (!instance) throw new Error('INSTANCE_NOT_FOUND');
    const previous = await readFile(file, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      },
    );
    if (previous !== null) {
      const saved = parseEnv(previous);
      if (saved.GAME_OWNER !== instance.owner || !saved.GAME_CATALOG_DATABASE_URL)
        throw new Error('OWNER_MISMATCH');
      const url = new URL(saved.GAME_CATALOG_DATABASE_URL);
      if (decodeURIComponent(url.username).split('.')[0] !== role)
        throw new Error('ROLE_MISMATCH');
      const existing = connectDatabase(url.href, process.env.DATABASE_CA_CERT);
      try {
        await authorizeCatalog(existing.db, instance.owner);
      } finally {
        await existing.close();
      }
      console.log('Existing instance credentials verified; unchanged');
      return;
    }
    const url = new URL(process.env.GAME_DATABASE_URL);
    const reader = decodeURIComponent(url.username);
    if (!/^quiz_game_reader(?:\.|$)/.test(reader)) throw new Error('UNEXPECTED_READER');
    const password = Array.from(randomBytes(32), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    url.username = reader.replace(/^quiz_game_reader/, role);
    url.password = password;
    await admin.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${role}, 0))`);
      const existing = await tx.execute(
        sql`select 1 from pg_roles where rolname = ${role}`,
      );
      if (existing.length) throw new Error('ROLE_EXISTS_CREDENTIALS_REQUIRED');
      const commands = await tx.execute(
        sql`select format('CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', ${role}::text, ${password}::text) as create_role, format('GRANT quiz_game_catalog TO %I', ${role}::text) as grant_role`,
      );
      await tx.execute(sql.raw(String(commands[0].create_role)));
      await tx.execute(sql.raw(String(commands[0].grant_role)));
      await tx.insert(catalogOperators).values({ roleName: role, owner: instance.owner });
      // Save exclusively before commit. An uncertain commit retains the credential for diagnosis.
      await writeFile(
        file,
        `GAME_OWNER=${instance.owner}\nGAME_CATALOG_DATABASE_URL=${url.href}\n`,
        { flag: 'wx', mode: 0o600 },
      );
    });
    const operator = connectDatabase(url.href, process.env.DATABASE_CA_CERT);
    try {
      await authorizeCatalog(operator.db, instance.owner);
    } finally {
      await operator.close();
    }
    console.log(`Instance catalog credentials verified and saved to ${file}`);
  } finally {
    await admin.close();
  }
}
main().catch(() => {
  console.error(
    'INSTANCE_CATALOG_SETUP_FAILED: credentials were not printed or overwritten; check instance, role and credential file.',
  );
  process.exitCode = 1;
});
