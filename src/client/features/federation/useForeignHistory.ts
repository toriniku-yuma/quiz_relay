import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { FederatedResult } from '../../../shared/federation-results';
import type { HistoryEntry } from '../../../shared/results';
import { organizationRequest } from '../organization/useOrganization';

type Page = {
  history: (FederatedResult & { peerOrigin: string })[];
  nextCursor: string | null;
};
export function useForeignHistory(actorId: string | undefined, instanceId: string) {
  const scope = `${actorId}:${instanceId}`,
    activeScope = useRef(scope);
  activeScope.current = scope;
  const [snapshot, setSnapshot] = useState<{ scope: string; data: Page } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [review, setReview] = useState<{
      scope: string;
      eventId: string;
      questions: NonNullable<HistoryEntry['questions']>;
    } | null>(null);
  const data = snapshot?.scope === scope ? snapshot.data : null;
  const load = useCallback(
    async (cursor?: string) => {
      if (!actorId || !instanceId) return;
      setBusy(true);
      setError('');
      try {
        const page = await organizationRequest<Page>(API_PATHS.federationResults, {
          operation: 'history',
          instanceId,
          ...(cursor ? { cursor } : {}),
        });
        if (activeScope.current === scope)
          setSnapshot((previous) => ({
            scope,
            data:
              cursor && previous?.scope === scope
                ? {
                    ...page,
                    history: [
                      ...previous.data.history,
                      ...page.history.filter(
                        (entry) =>
                          !previous.data.history.some(
                            (old) =>
                              old.peerOrigin === entry.peerOrigin &&
                              old.eventId === entry.eventId,
                          ),
                      ),
                    ],
                  }
                : page,
          }));
      } catch {
        if (activeScope.current === scope)
          setError('外部の対戦履歴を取得できませんでした。再試行してください。');
      } finally {
        if (activeScope.current === scope) setBusy(false);
      }
    },
    [actorId, instanceId, scope],
  );
  useEffect(() => {
    setSnapshot(null);
    setReview(null);
    setError('');
    void load();
  }, [load]);
  async function showReview(entry: Page['history'][number]) {
    setBusy(true);
    setError('');
    try {
      const value = await organizationRequest<{
        questions: NonNullable<HistoryEntry['questions']>;
      }>(API_PATHS.federationResults, {
        operation: 'review',
        peerOrigin: entry.peerOrigin,
        eventId: entry.eventId,
      });
      if (activeScope.current === scope)
        setReview({ scope, eventId: entry.eventId, ...value });
    } catch {
      if (activeScope.current === scope)
        setError(
          '開催元へ接続できないため、振り返りを表示できません。履歴は引き続き確認できます。',
        );
    } finally {
      if (activeScope.current === scope) setBusy(false);
    }
  }
  return {
    data,
    busy,
    error,
    load,
    showReview,
    review: review?.scope === scope ? review : null,
  };
}
