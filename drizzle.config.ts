import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/worker/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['quiz_game', 'quiz_probe'],
  dbCredentials: {
    url: process.env.GAME_MIGRATION_DATABASE_URL ?? '',
    ssl: process.env.DATABASE_CA_CERT
      ? { ca: process.env.DATABASE_CA_CERT, rejectUnauthorized: true }
      : true,
  },
});
