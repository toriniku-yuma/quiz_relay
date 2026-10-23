import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Only Vite's development configuration reads these secrets. Production builds do not.
export function localOperationsConfig(runtime: Record<string, string | undefined>) {
  if (!existsSync('.env.erasure-local')) return;
  const values = parseEnv(readFileSync('.env.erasure-local', 'utf8'));
  const secretKey = values.CLERK_SECRET_KEY;
  const publishableKey = values.CLERK_PUBLISHABLE_KEY;
  if (
    !secretKey ||
    !publishableKey ||
    secretKey !== runtime.CLERK_SECRET_KEY ||
    publishableKey !== runtime.CLERK_PUBLISHABLE_KEY
  )
    throw new Error('LOCAL_ERASURE_CONFIGURATION_MISMATCH');
  const profile = runtime.GAME_CONFIG_PROFILE;
  if (!profile) throw new Error('GAME_CONFIG_PROFILE_REQUIRED');
  const federationKeys = [
    'FEDERATION_ORIGIN',
    'SIGNING_KID',
    'SIGNING_PRIVATE_KEY',
  ] as const;
  const federation = Object.fromEntries(
    federationKeys.flatMap((key) => (runtime[key] ? [[key, runtime[key]]] : [])),
  );
  const federationCount = Object.keys(federation).length;
  if (federationCount !== 0 && federationCount !== federationKeys.length)
    throw new Error('FEDERATION_NOT_CONFIGURED');
  const authentication: Record<string, string> = {
    CLERK_SECRET_KEY: secretKey,
    CLERK_PUBLISHABLE_KEY: publishableKey,
    ...(values.CLERK_JWT_KEY ? { CLERK_JWT_KEY: values.CLERK_JWT_KEY } : {}),
  };
  return {
    ...authentication,
    GAME_CONFIG_PROFILE: profile,
    ...federation,
  };
}
