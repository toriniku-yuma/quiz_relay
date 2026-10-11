import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Only Vite's development configuration reads these secrets. Production builds do not.
export function localOperationsConfig(runtime: Record<string, string | undefined>) {
  if (!existsSync('.env.erasure-local')) return;
  const values = parseEnv(readFileSync('.env.erasure-local', 'utf8'));
  const matchingAuth =
    runtime.AUTH_PROVIDER === 'clerk' &&
    values.AUTH_PROVIDER === 'clerk' &&
    Boolean(values.CLERK_SECRET_KEY) &&
    Boolean(values.CLERK_PUBLISHABLE_KEY) &&
    values.CLERK_SECRET_KEY === runtime.CLERK_SECRET_KEY &&
    values.CLERK_PUBLISHABLE_KEY === runtime.CLERK_PUBLISHABLE_KEY;
  if (!matchingAuth) throw new Error('LOCAL_ERASURE_CONFIGURATION_MISMATCH');
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
  const authentication: Record<string, string> = {
    AUTH_PROVIDER: 'clerk',
    CLERK_SECRET_KEY: values.CLERK_SECRET_KEY ?? '',
    CLERK_PUBLISHABLE_KEY: values.CLERK_PUBLISHABLE_KEY ?? '',
    ...(values.CLERK_JWT_KEY ? { CLERK_JWT_KEY: values.CLERK_JWT_KEY } : {}),
  };
  return {
    ...authentication,
    GAME_CONFIG_PROFILE: runtime.GAME_CONFIG_PROFILE ?? 'default',
    LOCAL_ROOM_INVENTORY: JSON.stringify(ids.sort()),
    ...(runtime.FEDERATION_ORIGIN && runtime.SIGNING_KID && runtime.SIGNING_PRIVATE_KEY
      ? {
          FEDERATION_ORIGIN: runtime.FEDERATION_ORIGIN,
          SIGNING_KID: runtime.SIGNING_KID,
          SIGNING_PRIVATE_KEY: runtime.SIGNING_PRIVATE_KEY,
        }
      : {}),
  };
}
