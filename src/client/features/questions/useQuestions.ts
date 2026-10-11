import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS, instanceApiPath } from '../../../shared/api-paths';
import type {
  QuestionListQuery,
  QuestionOverview,
  QuestionView,
} from '../../../shared/questions';
import type { SortState } from '../../../shared/sorting';
import { setupAuth } from '../auth/client';

const messages: Record<string, string> = {
  PROFILE_REQUIRED: 'マイページで表示名を登録してから提出してください。',
  PARTICIPATION_RESTRICTED:
    '問題提出が制限されています。マイページで理由・期限を確認してください。',
  ALREADY_REPORTED: 'この問題・通報種別には、今回の審議ですでに通報しています。',
  INVALID_SETTINGS:
    '実力帯は昇順、割合は0以上にしてください。各帯の出題割合には少なくとも1つ正の値が必要です。',
  INVALID_CATEGORY: '有効な移動先カテゴリを選んでください。',
  INVALID_TAG: '統合元・統合先に、異なる既存のタグ名を指定してください。',
  INVALID_CHANGES: '対象は1〜500件で指定してください。',
  QUESTION_DELETED: '削除済みです。復元してから操作してください。',
  QUESTION_NOT_FOUND: '対象の問題を確認できません。',
  EDIT_CONFLICT:
    '他の操作で更新されました。このページを開き直して、現在の内容を確認してください。',
  SUBMISSION_FORBIDDEN: '現在の投稿方式・作問者資格では提出できません。',
  REVIEW_FORBIDDEN: '審査権限がないか、自分の問題です。自己承認は管理者だけが行えます。',
  REASON_REQUIRED: '理由を入力してください。',
  CATEGORY_REQUIRED: '有効なカテゴリを選んでください。',
  CATEGORY_IMPORT_ONLY: '取り込み専用カテゴリには投稿できません。',
  AUTHOR_REQUEST_UNAVAILABLE: '申請中・資格取得済み、または再申請の待機期間中です。',
  INSTANCE_PREPARING: 'このインスタンスは準備中です。',
  INSTANCE_ARCHIVED: 'アーカイブ済みです。問題のエクスポートを利用できます。',
};

export class QuestionRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function questionsRequest<T>(instanceId: string, body: object): Promise<T> {
  const client = await setupAuth();
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error('ログインしてください。');
  const response = await fetch(instanceApiPath(API_PATHS.questions, instanceId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = (await response.json()) as T & {
    code?: string;
    issues?: { path: string; message: string }[];
  };
  if (!response.ok)
    throw new QuestionRequestError(
      result.issues?.length
        ? result.issues
            .map((issue) => `${issue.path}: ${messages[issue.message] ?? issue.message}`)
            .join('\n')
        : (messages[result.code ?? ''] ??
            '操作を完了できませんでした。接続と現在の状態を確認してください。'),
      response.status,
    );
  return result;
}

export function useQuestions(
  instanceId: string,
  enabled: boolean,
  list?: QuestionListQuery,
  view?: QuestionView,
) {
  const requestBody = JSON.stringify({ operation: 'overview', list, view });
  const collection = JSON.stringify({
    instanceId,
    view,
    list: list && {
      scope: list.scope,
      query: list.query,
      category: list.category,
      status: list.status,
      pageSize: list.pageSize,
      band: list.band,
      players: list.players,
      shared: list.shared,
      sourceInstanceId: list.sourceInstanceId,
      peerOrigin: list.peerOrigin,
      sourceCategory: list.sourceCategory,
    },
  });
  const [loadedRequest, setLoadedRequest] = useState('');
  const [loadedCollection, setLoadedCollection] = useState('');
  const [displaySorting, setDisplaySorting] = useState<SortState>({
    sort: 'updatedAt',
    direction: 'desc',
  });
  const [data, setData] = useState<QuestionOverview | null>(null);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const requestSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setBusy(true);
    setError('');
    setLoadFailed(false);
    try {
      const result = await questionsRequest<QuestionOverview>(
        instanceId,
        JSON.parse(requestBody),
      );
      if (sequence === requestSequence.current) {
        setData(result);
        setLoadedRequest(requestBody);
        setLoadedCollection(collection);
        const requested = JSON.parse(requestBody).list;
        setDisplaySorting({
          sort: requested?.sort ?? 'updatedAt',
          direction: requested?.direction ?? 'desc',
        });
      }
    } catch (error) {
      if (sequence === requestSequence.current) {
        setLoadFailed(true);
        setError(error instanceof Error ? error.message : '通信に失敗しました。');
      }
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  }, [instanceId, requestBody, collection]);
  useEffect(() => {
    if (enabled && instanceId) void refresh();
    return () => {
      requestSequence.current++;
    };
  }, [enabled, instanceId, refresh]);
  async function mutate(body: object) {
    if (busy) return false;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await questionsRequest(instanceId, body);
      window.dispatchEvent(new Event('notifications:refresh'));
      setMessage('保存しました。');
      await refresh();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : '通信に失敗しました。');
      return false;
    } finally {
      setBusy(false);
    }
  }
  const retaining = loadedCollection === collection && loadedRequest !== requestBody;
  return {
    data,
    retaining,
    displaySorting,
    stale:
      loadedCollection !== collection ||
      (!retaining && (loadedRequest !== requestBody || loadFailed)),
    error,
    loadFailed,
    busy,
    message,
    mutate,
    refresh,
    setError,
  };
}
