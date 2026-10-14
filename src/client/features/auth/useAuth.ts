import { useEffect, useState } from 'react';
import type { AuthUser } from './clerk';
import { redirectSignedOut, setupAuth, signInWithGoogle, signOut } from './client';
import { publicPlayEntry } from './publicEntry';

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const publicEntry = publicPlayEntry(new URL(location.href));
    let storedSession = false;
    try {
      storedSession =
        typeof document !== 'undefined' && document.cookie?.includes('__session=');
    } catch {
      /* Private browsing can deny cookie access. */
    }
    let active = true;
    let revision = 0;
    let subject: string | undefined;
    let unsubscribe: (() => void) | undefined;
    const apply = (nextUser: AuthUser | null) => {
      if (nextUser) subject = nextUser.id;
      setUser(nextUser);
      if (!nextUser && (subject || storedSession || !publicEntry))
        redirectSignedOut(subject);
    };
    void setupAuth()
      .then(async (client) => {
        if (!active) return;
        unsubscribe = client.subscribe((nextUser) => {
          if (!active) return;
          revision++;
          apply(nextUser);
        });
        const checkedRevision = revision;
        const currentUser = await client.getUser();
        if (active && revision === checkedRevision) apply(currentUser);
      })
      .catch(() => {
        if (active)
          setMessage(
            'ログイン状態を確認できませんでした。Googleログインをやり直してください。',
          );
      })
      .finally(() => {
        if (active) setReady(true);
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
