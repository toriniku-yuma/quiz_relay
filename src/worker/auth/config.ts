import type { AuthConfig } from '../../shared/auth.ts';
import type { Env } from '../env.ts';

export function authConfig(env: Env): AuthConfig | undefined {
  if (env.AUTH_PROVIDER === 'clerk') {
    if (env.CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY)
      return { provider: 'clerk', publishableKey: env.CLERK_PUBLISHABLE_KEY };
    return;
  }
  if (env.AUTH_PROVIDER && env.AUTH_PROVIDER !== 'supabase') return;
  if (env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY)
    return { url: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY };
}
