import type { User } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { navigate } from '../../app/navigation';
import { GAME_PATH } from '../../app/paths';
import { hasAuthCallback } from './callback';
import {
  redirectSignedOut,
  sendLoginEmail,
  setupAuth,
  signInWithGoogle,
  signOut,
} from './client';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
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
            redirectSignedOut(subject);
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
          if (!data.user) redirectSignedOut(subject);
        }
      })
      .catch(() => {
        if (active)
          setMessage(
            'ログイン状態を確認できませんでした。最新のリンクでログインし直してください。',
          );
      })
      .finally(() => {
        if (active) {
          setReady(true);
          if (hasAuthCallback(new URL(location.href))) navigate(GAME_PATH, true);
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
    email: (email: string) =>
      run(
        () => sendLoginEmail(undefined, email),
        'メールを送りました。最新のリンクを、このブラウザーで開いてください。',
      ),
    google: () => run(() => signInWithGoogle()),
    logout: () => run(signOut),
  };
}
export type Auth = ReturnType<typeof useAuth>;
