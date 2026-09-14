import type { User } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { GAME_PATH } from '../../app/paths';
import { hasAuthCallback } from './callback';
import { sendLoginEmail, setupAuth, signInWithGoogle, signOut } from './client';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void setupAuth()
      .then(async (client) => {
        const { error } = await client.auth.initialize();
        if (error) throw error;
        const subscription = client.auth.onAuthStateChange((_event, session) => {
          if (active) setUser(session?.user ?? null);
        });
        unsubscribe = () => subscription.data.subscription.unsubscribe();
        if (!active) {
          unsubscribe();
          return;
        }
        const { data } = await client.auth.getUser();
        if (active) setUser(data.user);
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
          if (hasAuthCallback(new URL(location.href)))
            history.replaceState(null, '', GAME_PATH);
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
