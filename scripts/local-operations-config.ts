import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Only Vite's development configuration reads these secrets. Production builds do not.
export function localOperationsConfig(runtime: Record<string, string | undefined>) {
  if (!existsSync('.env.erasure-local')) return;
  const values = parseEnv(readFileSync('.env.erasure-local', 'utf8'));
  const database = new URL(values.ERASURE_DATABASE_URL ?? '');
  const application = new URL(runtime.ORGANIZATION_DATABASE_URL ?? '');
  const key = values.SUPABASE_SECRET_KEY || values.SUPABASE_SERVICE_ROLE_KEY;
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['postgres:', 'postgresql:'].includes(application.protocol) ||
    database.hostname !== '127.0.0.1' ||
    database.port !== '55432' ||
    database.pathname !== '/quiz_relay_dev' ||
    database.username !== 'quiz_erasure' ||
    database.search !== '?sslmode=disable' ||
    application.hostname !== database.hostname ||
    application.port !== database.port ||
    application.pathname !== database.pathname ||
    values.SUPABASE_URL !== runtime.SUPABASE_URL ||
    !key
  )
    throw new Error('LOCAL_ERASURE_CONFIGURATION_MISMATCH');
  const directory = resolve('.wrangler/state/v3/do/quiz-relay-probe-GameRoom');
  // Missing persistence is not evidence that a legacy namespace is empty.
  const files = readdirSync(directory);
  const ids = files.flatMap((name) => {
    if (name === 'metadata.sqlite') return [];
    if (/^(metadata|[a-f0-9]{64})\.sqlite-(wal|shm)$/.test(name)) {
      if (!files.includes(name.replace(/-(wal|shm)$/, '')))
        throw new Error('ORPHANED_LOCAL_ROOM_STATE');
      return [];
    }
    if (!/^[a-f0-9]{64}\.sqlite$/.test(name)) throw new Error('UNKNOWN_LOCAL_ROOM_FILE');
    return [name.slice(0, -7)];
  });
  return {
    ERASURE_DATABASE_URL: database.toString(),
    SUPABASE_URL: new URL(values.SUPABASE_URL ?? '').toString().replace(/\/$/, ''),
    SUPABASE_SECRET_KEY: key,
    LOCAL_ROOM_INVENTORY: JSON.stringify(ids.sort()),
  };
}
