import type { Clerk } from '@clerk/clerk-js';
import { API_PATHS } from '../../../shared/api-paths';
import { readAuthReturn, safeAuthReturn } from './callback';

export type AuthUser = {
  id: string;
  email?: string;
  user_metadata: Record<string, unknown>;
};
type AuthSession = { access_token: string; user: AuthUser };
type AuthFailure = { message: string; code?: string };
type AuthListener = (event: string, session: AuthSession | null) => void;

// The existing callers use only these operations; remove the Supabase branch after cutover.
export type AuthClient = {
  auth: {
    initialize(): Promise<{ error: AuthFailure | null }>;
    getSession(): Promise<{
      data: { session: AuthSession | null };
      error: AuthFailure | null;
    }>;
    getUser(): Promise<{ data: { user: AuthUser | null }; error: AuthFailure | null }>;
    onAuthStateChange(listener: AuthListener): {
      data: { subscription: { unsubscribe(): void } };
    };
    signInWithOAuth(options: {
      provider: 'google';
      options: { redirectTo: string };
    }): Promise<{ error: AuthFailure | null }>;
    signOut(options?: { scope: 'local' }): Promise<{ error: AuthFailure | null }>;
    dispose(): Promise<void>;
  };
};

function failure(error: unknown): AuthFailure {
  return { message: error instanceof Error ? error.message : 'AUTH_UNAVAILABLE' };
}

function returnPath() {
  const path = readAuthReturn();
  return path ?? '/game/';
}

export function createClerkAuth(publishableKey: string): AuthClient {
  let loaded: Promise<Clerk> | undefined;
  let removeListener: (() => void) | undefined;
  let disposed = false;
  let revision = 0;
  let previous: AuthSession | null | undefined;
  let identity: { userId: string; promise: Promise<AuthUser> } | undefined;
  const listeners = new Set<AuthListener>();

  async function snapshot(clerk: Clerk): Promise<AuthSession | null> {
    if (!clerk.session || !clerk.user) return null;
    const sessionId = clerk.session.id;
    const userId = clerk.user.id;
    const token = await clerk.session.getToken();
    if (!token) throw new Error('AUTH_TOKEN_UNAVAILABLE');
    if (!identity || identity.userId !== userId) {
      const promise = fetch(API_PATHS.authIdentity, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      }).then(async (response) => {
        if (!response.ok) throw new Error('AUTH_IDENTITY_UNAVAILABLE');
        const value = (await response.json()) as { subject?: unknown };
        if (typeof value.subject !== 'string' || !value.subject)
          throw new Error('INVALID_AUTH_IDENTITY');
        return { id: value.subject, user_metadata: {} };
      });
      identity = { userId, promise };
      void promise.catch(() => {
        if (identity?.promise === promise) identity = undefined;
      });
    }
    const user = await identity.promise;
    if (clerk.session?.id !== sessionId || clerk.user?.id !== userId)
      throw new Error('AUTH_SESSION_CHANGED');
    return { access_token: token, user };
  }

  function load() {
    if (disposed) throw new Error('AUTH_CLIENT_DISPOSED');
    loaded ??= import('@clerk/clerk-js')
      .then(async ({ Clerk }) => {
        const clerk = new Clerk(publishableKey);
        await clerk.load({ telemetry: { disabled: true } });
        if (disposed) return clerk;
        if (new URL(location.href).searchParams.get('clerk-callback') === '1') {
          await clerk.handleRedirectCallback({
            signInFallbackRedirectUrl: returnPath(),
            signUpFallbackRedirectUrl: returnPath(),
          });
        }
        removeListener = clerk.addListener(() => {
          const current = ++revision;
          void snapshot(clerk)
            .then((session) => {
              if (disposed || current !== revision) return;
              const event =
                previous === undefined
                  ? 'INITIAL_SESSION'
                  : !session
                    ? 'SIGNED_OUT'
                    : previous?.user.id === session.user.id
                      ? 'TOKEN_REFRESHED'
                      : 'SIGNED_IN';
              previous = session;
              for (const listener of listeners) listener(event, session);
            })
            .catch(() => {
              // A transient network error must not be mistaken for a confirmed sign-out.
            });
        });
        return clerk;
      })
      .catch((error) => {
        loaded = undefined;
        throw error;
      });
    return loaded;
  }

  async function getSession() {
    try {
      return { data: { session: await snapshot(await load()) }, error: null };
    } catch (error) {
      return { data: { session: null }, error: failure(error) };
    }
  }

  return {
    auth: {
      initialize: async () => {
        const session = await getSession();
        return { error: session.error };
      },
      getSession,
      getUser: async () => {
        const result = await getSession();
        return { data: { user: result.data.session?.user ?? null }, error: result.error };
      },
      onAuthStateChange: (listener) => {
        listeners.add(listener);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                listeners.delete(listener);
              },
            },
          },
        };
      },
      signInWithOAuth: async ({ options }) => {
        try {
          const clerk = await load();
          if (!clerk.client) throw new Error('AUTH_NOT_READY');
          const requested = new URL(options.redirectTo, location.origin);
          const destination =
            requested.origin === location.origin
              ? safeAuthReturn(
                  `${requested.pathname}${requested.search}${requested.hash}`,
                )
              : undefined;
          await clerk.client.signIn.authenticateWithRedirect({
            strategy: 'oauth_google',
            redirectUrl: `${location.origin}/game/?clerk-callback=1`,
            redirectUrlComplete: `${location.origin}${destination ?? returnPath()}`,
          });
          return { error: null };
        } catch (error) {
          return { error: failure(error) };
        }
      },
      signOut: async (options) => {
        try {
          const clerk = await load();
          await clerk.signOut(
            options?.scope === 'local' && clerk.session
              ? { sessionId: clerk.session.id }
              : undefined,
          );
          return { error: null };
        } catch (error) {
          return { error: failure(error) };
        }
      },
      dispose: async () => {
        disposed = true;
        revision++;
        removeListener?.();
        listeners.clear();
      },
    },
  };
}
