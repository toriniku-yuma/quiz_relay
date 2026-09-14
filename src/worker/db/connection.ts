import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export function connectDatabase(url: string, ca?: string, viaHyperdrive = false) {
  const client = postgres(url, {
    prepare: false,
    ssl: viaHyperdrive ? false : ca ? { ca, rejectUnauthorized: true } : 'verify-full',
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
  });
  return { db: drizzle(client), close: () => client.end({ timeout: 5 }) };
}
