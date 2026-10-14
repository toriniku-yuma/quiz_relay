import { API_PATHS } from '../../../shared/api-paths';
import { readAuthConfig } from '../../../shared/auth';
import { participationId } from '../../../shared/participation';
import { navigate } from '../../app/navigation';
import { CASUAL_PATH, GAME_PATH, PROFILE_PATH, ROOMS_PATH } from '../../app/paths';
import { readWithdrawalReceipt } from '../profile/withdrawalReceipt';
import { AUTH_RETURN_KEY, safeAuthReturn } from './callback';
import { type AuthClient, createClerkAuth } from './clerk';

let auth: Promise<AuthClient> | undefined;

export function canAuthenticate() {
  return window.isSecureContext && Boolean(globalThis.crypto?.subtle);
}

export function setupAuth() {
  if (!canAuthenticate()) return Promise.reject(new Error('HTTPS_REQUIRED'));
  auth ??= fetch(API_PATHS.publicAuthConfig, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  })
    .then(async (response) => {
      const config = response.ok ? readAuthConfig(await response.json()) : undefined;
      if (!config) throw new Error('AUTH_NOT_CONFIGURED');
      return createClerkAuth(config.publishableKey);
    })
    .catch((error) => {
      auth = undefined;
      throw error;
    });
  return auth;
}

// Returns null when signed out.
export async function authToken() {
  return (await setupAuth()).getToken();
}

export async function checkIdentity() {
  try {
    const user = await (await setupAuth()).getUser();
    if (!user)
      return {
        authenticated: false,
        message: 'ログインしていません。Googleログインを開始してください。',
      };
  } catch (error) {
    return {
      authenticated: false,
      message: 'ログイン状態を確認できませんでした。Googleログインをやり直してください。',
      code: error instanceof Error ? error.message : 'AUTH_UNAVAILABLE',
    };
  }

  return { authenticated: true, message: 'ログイン・本人確認に成功しました。' };
}

export async function signInWithGoogle(destination?: string) {
  const client = await setupAuth();
  const target =
    destination ?? safeAuthReturn(`${location.pathname}${location.search}`) ?? GAME_PATH;
  try {
    localStorage.setItem(AUTH_RETURN_KEY, target);
  } catch {
    /* Clerk also carries the validated return path through its redirect. */
  }
  await client.signInWithGoogle(target);

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
  const guestPath = `${destination.pathname}${destination.search}`;

  const client = await setupAuth();
  const token = await client.getToken();
  if (token) {
    const revoked = await fetch(API_PATHS.logout, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(20000),
    });
    if (!revoked.ok) throw new Error('GAME_LOGOUT_FAILED');
  }
  try {
    await client.signOut();
  } catch (error) {
    const remaining = await client.getToken().catch(() => undefined);
    if (remaining === null) navigate(guestPath, true);
    throw error;
  }

  navigate(guestPath, true);
  return { signedOut: true };
}
