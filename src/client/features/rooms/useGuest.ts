import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { playRequest } from './api';
export function useGuest(enabled: boolean) {
  const [data, setData] = useState<{ id?: string; name: string | null } | null>(null),
    [error, setError] = useState('');
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const result = await playRequest<{ id?: string; name: string | null }>(
        API_PATHS.guest,
      );
      if (current !== revision.current) return;
      setData(result);
      setError('');
    } catch (caughtError) {
      if (current === revision.current)
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : 'ゲスト情報を確認できませんでした。',
        );
    }
  }, []);
  useEffect(() => {
    if (enabled) void refresh();
    return () => {
      revision.current++;
    };
  }, [enabled, refresh]);
  return { data, error, refresh };
}
