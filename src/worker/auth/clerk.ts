import { createClerkClient } from '@clerk/backend';
import type { ClerkKeys } from './config.ts';

export function clerkBackend(keys: Pick<ClerkKeys, 'secretKey'> & Partial<ClerkKeys>) {
  return createClerkClient({
    publishableKey: keys.publishableKey,
    secretKey: keys.secretKey,
    jwtKey: keys.jwtKey,
    telemetry: { disabled: true },
  });
}

export async function authenticateClerk(request: Request, keys: ClerkKeys) {
  const client = clerkBackend(keys);
  const origin = new URL(request.url).origin;
  const state = await client.authenticateRequest(request, {
    acceptsToken: 'session_token',
    authorizedParties: [origin],
  });
  if (!state.isAuthenticated) return null;
  const authentication = state.toAuth();
  if (!authentication.userId) return null;
  const frontendApi = atob(keys.publishableKey.replace(/^pk_(test|live)_/, '')).replace(
    /\$$/,
    '',
  );
  if (
    authentication.sessionClaims.iss !== `https://${frontendApi}` ||
    authentication.sessionClaims.azp !== origin
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
  return { subject: user.id, displayName: '作問者' };
}
