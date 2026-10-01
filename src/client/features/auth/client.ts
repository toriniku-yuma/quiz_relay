import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { API_PATHS } from '../../../shared/api-paths';
import { navigate } from '../../app/navigation';
import { GAME_PATH, PROFILE_PATH, ROOMS_PATH } from '../../app/paths';
import { probeRequest } from '../debug/api';
import { readWithdrawalReceipt } from '../profile/withdrawalReceipt';

type AuthConfig = { url: string; publishableKey: string };

const storageKey = 'probe-auth-config';

let activeConfig: AuthConfig | undefined;
let auth: SupabaseClient | undefined;
let restored = false;

export function canAuthenticate() {
  return window.isSecureContext && Boolean(globalThis.crypto?.subtle);
}

function createAuth(config: AuthConfig) {
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
        const config = JSON.parse(saved);

        if (
          typeof config?.url !== 'string' ||
          typeof config?.publishableKey !== 'string'
        ) {
          throw new Error('INVALID_AUTH_CONFIG');
        }

        activeConfig = config;
        auth = createAuth(config);
      }
    } catch {
      localStorage.removeItem(storageKey);
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
  if (
    !config ||
    typeof config !== 'object' ||
    !('url' in config) ||
    !('publishableKey' in config) ||
    typeof config.url !== 'string' ||
    typeof config.publishableKey !== 'string'
  ) {
    throw new Error('AUTH_NOT_CONFIGURED');
  }

  const nextConfig = { url: config.url, publishableKey: config.publishableKey };
  if (
    !auth ||
    activeConfig?.url !== nextConfig.url ||
    activeConfig?.publishableKey !== nextConfig.publishableKey
  ) {
    await auth?.auth.dispose();
    auth = createAuth(nextConfig);
    activeConfig = nextConfig;
  }

  localStorage.setItem(storageKey, JSON.stringify(nextConfig));

  return auth;
}

export async function checkIdentity() {
  const auth = getAuth();
  if (!auth)
    return {
      authenticated: false,
      message:
        'ログイン開始時の情報がありません。メールを送信した同じブラウザー・同じURLで開いてください。別端末やメールアプリ内のブラウザーでは引き継げません。',
    };

  const { error: initializationError } = await auth.auth.initialize();
  if (initializationError)
    return {
      authenticated: false,
      message:
        'ログインリンクを確認できませんでした。この画面からメールを再送して、最新のリンクを送信時と同じブラウザーで開いてください。',
      code: initializationError.code,
    };

  const { data, error } = await auth.auth.getUser();
  if (error || !data.user)
    return {
      authenticated: false,
      message:
        'ログイン状態を確認できませんでした。メールを再送して、最新のリンクを送信時と同じブラウザーで開いてください。',
      code: error?.code,
    };

  return { authenticated: true, message: 'ログイン・本人確認に成功しました。' };
}

export async function sendLoginEmail(token: string | undefined, email: string) {
  const client = await setupAuth(token);
  localStorage.setItem(
    'quiz-relay-auth-return',
    token
      ? '/debug/'
      : location.pathname === ROOMS_PATH &&
          new URL(location.href).searchParams.has('room')
        ? `${location.pathname}${location.search}`
        : '/game/',
  );

  // Keep the registered root callback; the entry redirect preserves code/hash.
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${location.origin}/` },
  });
  if (error) throw error;

  return {
    sent: true,
    message:
      '最新のメールリンクを送信時と同じブラウザーで開いてください。連続して再送しないでください。',
  };
}

export async function signInWithGoogle(token?: string) {
  const client = await setupAuth(token);
  localStorage.setItem(
    'quiz-relay-auth-return',
    token
      ? '/debug/'
      : location.pathname === ROOMS_PATH &&
          new URL(location.href).searchParams.has('room')
        ? `${location.pathname}${location.search}`
        : '/game/',
  );
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${location.origin}/` },
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
  const response = await client?.auth.signOut();
  if (response?.error) {
    const session = await client?.auth.getSession();
    if (session && !session.error && !session.data.session) navigate(GAME_PATH, true);
    throw response.error;
  }

  navigate(GAME_PATH, true);
  return { signedOut: true };
}
