import { createClient } from '@supabase/supabase-js';
import { API_PATHS } from '../../../shared/api-paths';
import { type AuthConfig, readAuthConfig } from '../../../shared/auth';
import { participationId } from '../../../shared/participation';
import { navigate } from '../../app/navigation';
import {
  AUTHORIZE_PATH,
  CASUAL_PATH,
  GAME_PATH,
  PROFILE_PATH,
  ROOMS_PATH,
} from '../../app/paths';
import { probeRequest } from '../debug/api';
import { readWithdrawalReceipt } from '../profile/withdrawalReceipt';
import { safeAuthReturn } from './callback';
import { type AuthClient, createClerkAuth } from './clerk';

const storageKey = 'probe-auth-config';

let activeConfig: AuthConfig | undefined;
let auth: AuthClient | undefined;
let restored = false;

export function canAuthenticate() {
  return window.isSecureContext && Boolean(globalThis.crypto?.subtle);
}

function createAuth(config: AuthConfig) {
  if (config.provider === 'clerk') return createClerkAuth(config.publishableKey);
  return createClient(config.url, config.publishableKey, {
    auth: { flowType: 'pkce', storage: localStorage, detectSessionInUrl: true },
  });
}

export function getAuth() {
  if (!restored && canAuthenticate()) {
    restored = true;

    try {
      const saved = localStorage.getItem(storageKey);

      if (saved) {
        const config = readAuthConfig(JSON.parse(saved));
        if (!config) throw new Error('INVALID_AUTH_CONFIG');

        activeConfig = config;
        auth = createAuth(config);
      }
    } catch {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* Browser storage is optional. */
      }
    }
  }

  return auth;
}

export async function setupAuth(token?: string) {
  if (!canAuthenticate()) throw new Error('HTTPS_REQUIRED');

  getAuth();
  const config = token
    ? await probeRequest(token, API_PATHS.authConfig)
    : await fetch(API_PATHS.publicAuthConfig, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      }).then(async (response) => {
        if (!response.ok) throw new Error('AUTH_NOT_CONFIGURED');
        return response.json();
      });
  const nextConfig = readAuthConfig(config);
  if (!nextConfig) throw new Error('AUTH_NOT_CONFIGURED');
  if (!auth || JSON.stringify(activeConfig) !== JSON.stringify(nextConfig)) {
    await auth?.auth.dispose();
    auth = createAuth(nextConfig);
    activeConfig = nextConfig;
  }

  try {
    localStorage.setItem(storageKey, JSON.stringify(nextConfig));
  } catch {
    /* The live auth client can work without saved configuration. */
  }

  return auth;
}

export async function checkIdentity() {
  const auth = getAuth();
  if (!auth)
    return {
      authenticated: false,
      message:
        'ログイン開始時の情報がありません。このブラウザーでGoogleログインを開始してください。',
    };

  const { error: initializationError } = await auth.auth.initialize();
  if (initializationError)
    return {
      authenticated: false,
      message: 'ログインを確認できませんでした。Googleログインをやり直してください。',
      code: initializationError.code,
    };

  const { data, error } = await auth.auth.getUser();
  if (error || !data.user)
    return {
      authenticated: false,
      message: 'ログイン状態を確認できませんでした。Googleログインをやり直してください。',
      code: error?.code,
    };

  return { authenticated: true, message: 'ログイン・本人確認に成功しました。' };
}

export async function signInWithGoogle(token?: string) {
  const client = await setupAuth(token);
  const destination = token
    ? '/debug/'
    : location.pathname === AUTHORIZE_PATH
      ? (safeAuthReturn(`${location.pathname}${location.search}`) ?? GAME_PATH)
      : (safeAuthReturn(`${location.pathname}${location.search}`) ?? GAME_PATH);
  try {
    localStorage.setItem('quiz-relay-auth-return', destination);
  } catch {
    /* Clerk also carries the validated return path through its redirect. */
  }
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${location.origin}${activeConfig?.provider === 'clerk' ? destination : '/'}`,
    },
  });
  if (error) throw error;

  return { redirecting: true };
}

export function redirectSignedOut(subject?: string) {
  const url = new URL(location.href);
  if (
    url.pathname === PROFILE_PATH &&
    url.searchParams.get('view') === 'withdrawal' &&
    readWithdrawalReceipt(subject)
  )
    return;
  navigate(GAME_PATH, true);
}

export async function signOut() {
  const current = new URL(location.href),
    destination = new URL(
      [CASUAL_PATH, ROOMS_PATH].includes(current.pathname) ? current.pathname : GAME_PATH,
      current.origin,
    );
  destination.searchParams.set('guest', '1');
  const instanceId = current.searchParams.get('instance');
  if (participationId(instanceId)) destination.searchParams.set('instance', instanceId);
  const client = getAuth();
  if (client) {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (data.session) {
      const revoked = await fetch(API_PATHS.logout, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${data.session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(20000),
      });
      if (!revoked.ok) throw new Error('GAME_LOGOUT_FAILED');
    }
  }
  const response = await client?.auth.signOut({ scope: 'local' });
  if (response?.error) {
    const session = await client?.auth.getSession();
    if (session && !session.error && !session.data.session)
      navigate(`${destination.pathname}${destination.search}`, true);
    throw response.error;
  }

  navigate(`${destination.pathname}${destination.search}`, true);
  return { signedOut: true };
}
