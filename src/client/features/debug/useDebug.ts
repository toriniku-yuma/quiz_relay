import { useCallback, useEffect, useState } from 'react';
import type { ApiPath } from '../../../shared/api-paths';
import { DEBUG_PATH } from '../../app/paths';
import { hasAuthCallback } from '../auth/callback';
import {
  checkIdentity,
  getAuth,
  sendLoginEmail,
  signInWithGoogle,
  signOut,
} from '../auth/client';
import { formatProbeError, probeRequest } from './api';

export function useDebug() {
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<unknown>('未実行');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (task: () => Promise<unknown>) => {
    setBusy(true);

    try {
      setResult(await task());
    } catch (error) {
      setResult(formatProbeError(error));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const returned = hasAuthCallback(new URL(location.href));
    if (!getAuth() && !returned) return;

    void run(async () => {
      try {
        return await checkIdentity();
      } finally {
        if (returned) history.replaceState(null, '', DEBUG_PATH);
      }
    });
  }, [run]);

  return {
    token,
    setToken,
    email,
    setEmail,
    result,
    busy,
    request: (path: ApiPath, method = 'GET') =>
      run(() => probeRequest(token, path, method)),
    sendEmail: () => run(() => sendLoginEmail(token, email)),
    googleLogin: () => run(() => signInWithGoogle(token)),
    checkIdentity: () => run(checkIdentity),
    signOut: () => run(signOut),
  };
}

export type DebugController = ReturnType<typeof useDebug>;
