import { useEffect, useState } from 'react';
import { navigate } from '../../app/navigation';
import { GAME_PATH } from '../../app/paths';
import { hasAuthCallback, readAuthReturn } from './callback';
import type { AuthUser } from './clerk';
import { redirectSignedOut, setupAuth, signInWithGoogle, signOut } from './client';
import { publicPlayEntry } from './publicEntry';

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const initialUrl = new URL(location.href);
    const publicEntry = publicPlayEntry(initialUrl);
    let storedAuthentication = false;
    try {
      storedAuthentication =
        (typeof localStorage !== 'undefined' &&
          Object.keys(localStorage).some((key) => /^sb-.*-auth-token$/.test(key))) ||
        (typeof document !== 'undefined' && document.cookie?.includes('__session='));
    } catch {
      /* Private browsing can deny storage access. */
    }
    const signedOut = (actualLogout = false) => {
      if (actualLogout || subject || storedAuthentication || !publicEntry)
        redirectSignedOut(subject);
    };
    let active = true;
    let revision = 0;
    let subject: string | undefined;
    let unsubscribe: (() => void) | undefined;
    void setupAuth()
      .then(async (client) => {
        if (!active) return;
        const subscription = client.auth.onAuthStateChange((event, session) => {
          if (!active) return;
          revision++;
          if (session?.user) subject = session.user.id;
          setUser(session?.user ?? null);
          if (!session && (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION'))
            signedOut(event === 'SIGNED_OUT');
        });
        unsubscribe = () => subscription.data.subscription.unsubscribe();
        const { error } = await client.auth.initialize();
        if (error) throw error;
        if (!active) return;
        const checkedRevision = revision;
        const { data, error: identityError } = await client.auth.getUser();
        if (active && revision === checkedRevision) {
          if (identityError) throw identityError;
          if (data.user) subject = data.user.id;
          setUser(data.user);
          if (!data.user) signedOut();
        }
      })
      .catch(() => {
        if (active)
          setMessage(
            'ログイン状態を確認できませんでした。Googleログインをやり直してください。',
          );
      })
      .finally(() => {
        if (active) {
          setReady(true);
          const callbackUrl = new URL(location.href);
          if (
            hasAuthCallback(callbackUrl) &&
            callbackUrl.searchParams.get('clerk-callback') !== '1'
          ) {
            const target = readAuthReturn();
            navigate(subject && target ? target : GAME_PATH, true);
          }
        }
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  async function run(task: () => Promise<unknown>, success = '') {
    setBusy(true);
    setMessage('');
    try {
      await task();
      setMessage(success);
    } catch {
      setMessage('ログイン操作を完了できませんでした。時間を置いて再度お試しください。');
    } finally {
      setBusy(false);
    }
  }
  return {
    user,
    ready,
    busy,
    message,
    google: () => run(() => signInWithGoogle()),
    logout: () => run(signOut),
  };
}
export type Auth = ReturnType<typeof useAuth>;
