import type { Clerk } from '@clerk/clerk-js';
import { API_PATHS } from '../../../shared/api-paths';
import { GAME_PATH } from '../../app/paths';
import { readAuthReturn, safeAuthReturn } from './callback';

export type AuthUser = { id: string };
type AuthListener = (user: AuthUser | null) => void;

export type AuthClient = {
  // Returns null only when no session exists; failures throw.
  getToken(): Promise<string | null>;
  getUser(): Promise<AuthUser | null>;
  // Notifies only when the signed-in user changes, not on token refresh.
  subscribe(listener: AuthListener): () => void;
  signInWithGoogle(destination: string): Promise<void>;
  signOut(): Promise<void>;
};

const callbackPath = `${GAME_PATH}?clerk-callback=1`;

function returnPath() {
  return readAuthReturn() ?? GAME_PATH;
}

export function createClerkAuth(publishableKey: string): AuthClient {
  let loaded: Promise<Clerk> | undefined;
  let revision = 0;
  let notifiedUserId: string | null | undefined;
  let identity: { userId: string; promise: Promise<AuthUser> } | undefined;
  const listeners = new Set<AuthListener>();

  // The server confirms that the session is acceptable (Google only, not locked).
  function verifiedUser(userId: string, token: string) {
    if (!identity || identity.userId !== userId) {
      const promise = fetch(API_PATHS.authIdentity, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      }).then(async (response) => {
        if (!response.ok) throw new Error('AUTH_IDENTITY_UNAVAILABLE');
        const value = (await response.json()) as { subject?: unknown };
        if (value.subject !== userId) throw new Error('INVALID_AUTH_IDENTITY');
        return { id: userId };
      });
      identity = { userId, promise };
      void promise.catch(() => {
        if (identity?.promise === promise) identity = undefined;
      });
    }
    return identity.promise;
  }

  async function currentUser(clerk: Clerk): Promise<AuthUser | null> {
    if (!clerk.session || !clerk.user) return null;
    const sessionId = clerk.session.id;
    const userId = clerk.user.id;
    const token = await clerk.session.getToken();
    if (!token) throw new Error('AUTH_TOKEN_UNAVAILABLE');
    const user = await verifiedUser(userId, token);
    if (clerk.session?.id !== sessionId || clerk.user?.id !== userId)
      throw new Error('AUTH_SESSION_CHANGED');
    return user;
  }

  function watch(clerk: Clerk) {
    clerk.addListener(() => {
      const userId = clerk.session && clerk.user ? clerk.user.id : null;
      if (notifiedUserId === undefined) notifiedUserId = userId;
      if (userId === notifiedUserId) return;
      notifiedUserId = userId;
      const current = ++revision;
      void currentUser(clerk)
        .then((user) => {
          if (current !== revision) return;
          for (const listener of listeners) listener(user);
        })
        .catch(() => {
          // A transient network error must not be mistaken for a confirmed sign-out.
        });
    });
  }

  function load() {
    loaded ??= import('@clerk/clerk-js')
      .then(async ({ Clerk }) => {
        const clerk = new Clerk(publishableKey);
        await clerk.load({ telemetry: { disabled: true } });
        if (new URL(location.href).searchParams.get('clerk-callback') === '1') {
          await clerk.handleRedirectCallback({
            signInFallbackRedirectUrl: returnPath(),
            signUpFallbackRedirectUrl: returnPath(),
          });
        }
        watch(clerk);
        return clerk;
      })
      .catch((error) => {
        loaded = undefined;
        throw error;
      });
    return loaded;
  }

  return {
    getToken: async () => {
      const clerk = await load();
      if (!clerk.session) return null;
      const token = await clerk.session.getToken();
      if (!token) throw new Error('AUTH_TOKEN_UNAVAILABLE');
      return token;
    },
    getUser: async () => currentUser(await load()),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    signInWithGoogle: async (destination) => {
      const path = safeAuthReturn(destination);
      if (!path) throw new Error('INVALID_AUTH_RETURN');
      const clerk = await load();
      if (!clerk.client) throw new Error('AUTH_NOT_READY');
      await clerk.client.signIn.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: `${location.origin}${callbackPath}`,
        redirectUrlComplete: `${location.origin}${path}`,
      });
    },
    signOut: async () => {
      const clerk = await load();
      await clerk.signOut(clerk.session ? { sessionId: clerk.session.id } : undefined);
    },
  };
}
