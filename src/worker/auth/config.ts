import { type AuthConfig, readAuthConfig } from '../../shared/auth.ts';
import type { Env } from '../env.ts';

export type ClerkKeys = {
  publishableKey: string;
  secretKey: string;
  jwtKey: string | undefined;
};

export function clerkKeys(
  env: Pick<Env, 'CLERK_PUBLISHABLE_KEY' | 'CLERK_SECRET_KEY' | 'CLERK_JWT_KEY'>,
): ClerkKeys | undefined {
  const config = readAuthConfig({ publishableKey: env.CLERK_PUBLISHABLE_KEY });
  if (!config || !env.CLERK_SECRET_KEY) return;
  return {
    publishableKey: config.publishableKey,
    secretKey: env.CLERK_SECRET_KEY,
    jwtKey: env.CLERK_JWT_KEY,
  };
}

// Only the publishable key leaves the Worker.
export function authConfig(env: Env): AuthConfig | undefined {
  const keys = clerkKeys(env);
  if (keys) return { publishableKey: keys.publishableKey };
}
