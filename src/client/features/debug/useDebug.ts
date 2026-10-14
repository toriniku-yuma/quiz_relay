import { useCallback, useEffect, useState } from 'react';
import type { ApiPath } from '../../../shared/api-paths';
import { DEBUG_PATH } from '../../app/paths';
import { checkIdentity, signInWithGoogle, signOut } from '../auth/client';
import { formatProbeError, probeRequest } from './api';

export function useDebug() {
  const [token, setToken] = useState('');
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
    void run(checkIdentity);
  }, [run]);

  return {
    token,
    setToken,
    result,
    busy,
    request: (path: ApiPath, method = 'GET') =>
      run(() => probeRequest(token, path, method)),
    googleLogin: () => run(() => signInWithGoogle(DEBUG_PATH)),
    checkIdentity: () => run(checkIdentity),
    signOut: () => run(signOut),
  };
}

export type DebugController = ReturnType<typeof useDebug>;
