import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type {
  HistoryCursor,
  ResultsOverview,
  ResultsQuery,
} from '../../../shared/results';
import { playRequest } from '../rooms/api';

export function useResults(
  refreshKey: string,
  instanceId = '',
  query: ResultsQuery = {},
  guest = false,
) {
  const [data, setData] = useState<ResultsOverview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const retryCursor = useRef<HistoryCursor | undefined>(undefined);
  const queryKey = JSON.stringify(query);
  const scope = JSON.stringify([instanceId, refreshKey, guest, queryKey]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const dataScope = useRef(scope);

  const load = useCallback(
    async (cursor?: HistoryCursor) => {
      if (currentScope.current !== scope) return;
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const signal = controller.signal;
      const valid = () => !signal.aborted && currentScope.current === scope;

      setBusy(true);
      setError('');
      try {
        retryCursor.current = cursor;
        const value = await playRequest<ResultsOverview>(
          guest ? API_PATHS.playResults : API_PATHS.results,
          { ...JSON.parse(queryKey), ...(cursor ? { cursor } : {}) },
          instanceId,
          signal,
        );
        if (valid()) {
          dataScope.current = scope;
          setData((previous) =>
            cursor && previous
              ? {
                  ...value,
                  history: [
                    ...previous.history,
                    ...value.history.filter(
                      (entry) =>
                        !previous.history.some((old) => old.resultId === entry.resultId),
                    ),
                  ],
                }
              : value,
          );
        }
      } catch {
        if (valid()) setError('読み込めませんでした。再試行してください。');
      } finally {
        if (valid()) setBusy(false);
      }
    },
    [instanceId, queryKey, guest, scope],
  );
  const refresh = useCallback(() => load(), [load]);

  useEffect(() => {
    setData(null);
    setError('');
    if (!refreshKey) return;
    void refresh();
    const onProfile = () => void refresh();
    const onResults = (event: Event) => {
      if (
        (query.section === 'self' || query.section === 'ranking') &&
        (event as CustomEvent<{ instanceId: string }>).detail?.instanceId === instanceId
      )
        void refresh();
    };
    window.addEventListener('profile:refresh', onProfile);
    window.addEventListener('results:refresh', onResults);
    return () => {
      activeRequest.current?.abort();
      window.removeEventListener('profile:refresh', onProfile);
      window.removeEventListener('results:refresh', onResults);
    };
  }, [refresh, refreshKey, instanceId, query.section]);

  return {
    data: dataScope.current === scope ? data : null,
    error,
    busy,
    refresh,
    retry: () => load(retryCursor.current),
    loadMore: () => (data?.nextCursor ? load(data.nextCursor) : Promise.resolve()),
  };
}
