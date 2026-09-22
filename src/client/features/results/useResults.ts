import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS, instanceApiPath } from '../../../shared/api-paths';
import type { ResultsOverview } from '../../../shared/results';
import { setupAuth } from '../auth/client';

export function useResults(refreshKey: string, instanceId = '') {
  const [data, setData] = useState<ResultsOverview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const signal = controller.signal;

    setBusy(true);
    setError('');
    try {
      const client = await setupAuth();
      const { data } = await client.auth.getSession();
      if (signal.aborted) return;
      if (!data.session) throw new Error('AUTH_REQUIRED');
      const response = await fetch(instanceApiPath(API_PATHS.results, instanceId), {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session.access_token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error('RESULTS_UNAVAILABLE');
      const value = (await response.json()) as ResultsOverview;
      if (!signal.aborted) setData(value);
    } catch {
      if (!signal.aborted)
        setError('履歴とランキングを読み込めませんでした。再読み込みしてください。');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }, [instanceId]);

  useEffect(() => {
    if (!refreshKey) return;
    void refresh();
    return () => activeRequest.current?.abort();
  }, [refresh, refreshKey]);

  return { data, error, busy, refresh };
}
