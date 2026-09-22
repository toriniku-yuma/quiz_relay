import { useCallback, useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { OrganizationOverview } from '../../../shared/organization';
import { setupAuth } from '../auth/client';
import { creationRequest } from './creationRequest';

const errors: Record<string, string> = {
  RATE_LIMIT: '操作が多いため、少し待ってから再試行してください。',
  EDIT_CONFLICT: '他の操作で変更されました。一覧を再読み込みして内容を確認してください。',
  SETUP_FORBIDDEN: '設置者が指定したアカウントでログインしてください。',
  ALREADY_CONFIGURED: '初回設定は完了しています。一覧を再読み込みしてください。',
  ADMIN_REQUIRED: 'この操作には組織管理者の権限が必要です。',
  INVALID_NAME: '名前を1〜80文字で入力してください。',
  INSTANCE_CONFLICT: '同じ追加要求の内容が変わっています。一覧を確認してください。',
};
export async function organizationRequest(path: string, body: object = {}) {
  const client = await setupAuth();
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error('ログインしてください。');
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result = (await response.json()) as OrganizationOverview & { code?: string };
  if (!response.ok)
    throw new Error(
      errors[result.code ?? ''] ??
        '組織情報を読み込めませんでした。接続設定を確認して再試行してください。',
    );
  return result;
}

export function useOrganization(enabled = true) {
  const [version, setVersion] = useState(0);
  const [data, setData] = useState<OrganizationOverview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setData(await organizationRequest(API_PATHS.organizationOverview));
      setVersion((value) => value + 1);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : '通信に失敗しました。');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);
  async function mutate(path: string, body: object) {
    setBusy(true);
    setError('');
    try {
      const key = `quiz-relay-instance-request:${data?.organization?.id}:${data?.account?.actorId}`;
      if (path === API_PATHS.organizationAdd) {
        if (!data?.organization?.id || !data.account?.actorId)
          throw new Error('組織情報を再読み込みしてください。');
        body = creationRequest(localStorage, key, (body as { name?: unknown }).name);
      }
      await organizationRequest(path, body);
      const refreshed = await refresh();
      if (!refreshed) {
        setError(
          '保存は完了しましたが一覧を取得できませんでした。再読み込みしてください。',
        );
        return false;
      }
      if (path === API_PATHS.organizationAdd) localStorage.removeItem(key);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : '通信に失敗しました。');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function moreAccounts() {
    if (!data?.nextAccountCursor || busy) return;
    setBusy(true);
    setError('');
    try {
      const page = await organizationRequest(API_PATHS.organizationOverview, {
        accountCursor: data.nextAccountCursor,
      });
      setData((current) =>
        current
          ? {
              ...current,
              accounts: [...(current.accounts ?? []), ...(page.accounts ?? [])],
              nextAccountCursor: page.nextAccountCursor,
            }
          : page,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '取得できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return { data, error, busy, refresh, mutate, version, moreAccounts };
}
