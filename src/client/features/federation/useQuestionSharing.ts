import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { QuestionSharingOverview } from '../../../shared/federation-questions';
import { organizationRequest } from '../organization/useOrganization';

const sharingErrors: Record<string, string> = {
  QUESTION_IMPORT_OVERLAP:
    'この共有元のカテゴリは既に受け取る設定があります。既存の設定を変更するか、別のカテゴリを選んでください。',
  QUESTION_IMPORT_CONFLICT:
    '他の操作で設定が変更されました。フォームを閉じて、もう一度開いてください。',
  CATEGORY_CONFLICT:
    '同じ名前のカテゴリがあります。既存のカテゴリを選ぶか、別の名前にしてください。',
  QUESTION_IMPORT_DENIED: 'この共有元からの問題の受け取りが許可されていません。',
};

export function useQuestionSharing(
  instanceId: string,
  actorId: string,
  enabled: boolean,
) {
  const key = `${instanceId}:${actorId}`,
    active = useRef(key);
  active.current = key;
  const [snapshot, setSnapshot] = useState<{
      key: string;
      data: QuestionSharingOverview;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [loadFailed, setLoadFailed] = useState(false),
    [error, setError] = useState('');
  const request = useCallback(
    async <T>(body: object, quiet = false): Promise<T | null> => {
      if (!enabled) return null;
      if (!quiet) {
        setBusy(true);
        setError('');
      }
      try {
        const result = await organizationRequest<T>(API_PATHS.federationQuestions, {
          ...body,
          instanceId,
        });
        return active.current === key ? result : null;
      } catch (error) {
        if (active.current === key && !quiet)
          setError(
            error instanceof Error
              ? (sharingErrors[error.message] ?? error.message)
              : '共有問題の操作を完了できません。',
          );
        return null;
      } finally {
        if (active.current === key && !quiet) setBusy(false);
      }
    },
    [instanceId, key, enabled],
  );
  const refresh = useCallback(async () => {
    const result = await request<QuestionSharingOverview>(
      { operation: 'overview' },
      true,
    );
    if (active.current === key) {
      setLoadFailed(!result);
      if (result) setSnapshot({ key, data: result });
    }
  }, [request, key]);
  useEffect(() => {
    setSnapshot(null);
    setError('');
    if (enabled) void refresh();
    const timer = enabled
      ? window.setInterval(() => {
          if (document.visibilityState === 'visible') void refresh();
        }, 15000)
      : undefined;
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);
  async function mutate(body: object) {
    const result = await request(body);
    if (!result) return false;
    await refresh();
    return true;
  }
  return {
    data: snapshot?.key === key ? snapshot.data : null,
    busy,
    error,
    loadFailed,
    request,
    refresh,
    mutate,
  };
}
