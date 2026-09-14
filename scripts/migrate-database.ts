import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connectDatabase } from '../src/worker/db/connection.ts';

async function main() {
  const url = process.env.GAME_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('GAME_MIGRATION_DATABASE_URL_REQUIRED');
  const { db, close } = connectDatabase(url, process.env.DATABASE_CA_CERT);
  try {
    await migrate(db, { migrationsFolder: 'drizzle' });
    console.log('Database migrations applied');
  } finally {
    await close();
  }
}
main().catch(() => {
  console.error('DB_MIGRATION_FAILED: inspect migration and connection setup.');
  process.exitCode = 1;
});
