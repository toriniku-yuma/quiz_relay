import { createClerkClient, type User } from '@clerk/backend';
import type { Env } from '../env.ts';

export const legacySubjectPrefix = 'quiz-relay:supabase:';
const legacySubject = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// externalId is set only through the trusted Backend API; never merge by email or user metadata.
export function clerkSubject(user: Pick<User, 'id' | 'externalId'>) {
  if (user.externalId === null) return user.id;
  const subject = user.externalId.startsWith(legacySubjectPrefix)
    ? user.externalId.slice(legacySubjectPrefix.length)
    : '';
  if (!legacySubject.test(subject)) throw new Error('INVALID_AUTH_MAPPING');
  return subject;
}

export function clerkBackend(
  env: Pick<Env, 'CLERK_PUBLISHABLE_KEY' | 'CLERK_SECRET_KEY' | 'CLERK_JWT_KEY'>,
) {
  return createClerkClient({
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
    jwtKey: env.CLERK_JWT_KEY,
    telemetry: { disabled: true },
  });
}

export async function authenticateClerk(request: Request, env: Env) {
  const client = clerkBackend(env);
  const state = await client.authenticateRequest(request, {
    acceptsToken: 'session_token',
    authorizedParties: [new URL(request.url).origin],
  });
  if (!state.isAuthenticated) return null;
  const authentication = state.toAuth();
  if (!authentication.userId) return null;
  const frontendApi = atob(
    (env.CLERK_PUBLISHABLE_KEY ?? '').replace(/^pk_(test|live)_/, ''),
  ).replace(/\$$/, '');
  if (
    authentication.sessionClaims.iss !== `https://${frontendApi}` ||
    authentication.sessionClaims.azp !== new URL(request.url).origin
  )
    return null;
  const user = await client.users.getUser(authentication.userId);
  if (
    user.banned ||
    user.locked ||
    user.passwordEnabled ||
    !user.externalAccounts.some(
      (account) =>
        (account.provider === 'oauth_google' || account.provider === 'google') &&
        account.verification?.status === 'verified',
    )
  )
    return null;
  // Also disable email, phone, password, passkey and non-Google strategies in Clerk.
  // Linking Google alone cannot establish the sign-in strategy of an existing session.
  return { subject: clerkSubject(user), displayName: '作問者' };
}
