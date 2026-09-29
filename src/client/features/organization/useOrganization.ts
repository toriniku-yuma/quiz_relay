import { useCallback, useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { OrganizationOverview } from '../../../shared/organization';
import { setupAuth } from '../auth/client';
import { creationRequest } from './creationRequest';

const errors: Record<string, string> = {
  BAN_REQUIRES_REVOKE:
    'BANを別の種類に変更するには、先に理由を付けて取り消してください。',
  REPORT_NOT_ALLOWED: 'この試合の参加者だけが、対戦相手を通報できます。',
  APPEAL_PENDING: 'この処分には確認待ちの異議申し立てがあります。',
  TRANSFER_PENDING: 'このユーザーには有効な管理者引き継ぎ招待があります。',
  INVITATION_INVALID: '招待が期限切れ、取り消し済み、または対象外です。',
  INVALID_PAGE: '表示件数とページ番号を確認してください。',
  INVALID_SAMPLE: '集計対象を1以上の整数、または全件にしてください。',
  INVALID_REPORT: '対象の通報を確認してください。',
  INVALID_DECISION: '異議申し立てへの対応を選択してください。',
  MODERATION_REQUIRED: 'このインスタンスのユーザー管理権限が必要です。',
  PROTECTED_ACCOUNT: '自分自身、または権限上処分できない運営者です。',
  INVALID_SANCTION: '処分の種類と制限対象を確認してください。',
  INVALID_TIMEOUT: '終了日時は現在から1分以上30日以内にしてください。',
  REASON_REQUIRED: '理由を1〜1000文字で入力してください。',
  OPERATION_CONFLICT: '再試行の内容が変わっています。詳細を開き直してください。',
  SANCTION_NOT_FOUND: '指定した処分が見つかりません。',
  ACCOUNT_NOT_FOUND: '指定したユーザーが見つかりません。',
  RATE_LIMIT: '操作が多いため、少し待ってから再試行してください。',
  EDIT_CONFLICT: '他の操作で変更されました。ページを開き直して内容を確認してください。',
  SETUP_FORBIDDEN: '設置者が指定したアカウントでログインしてください。',
  ALREADY_CONFIGURED: '初回設定は完了しています。ページを開き直してください。',
  ADMIN_REQUIRED: 'この操作には組織管理者の権限が必要です。',
  INVALID_NAME: '名前を1〜80文字で入力してください。',
  INVALID_PROFILE: '表示名を1〜32文字で入力してください。改行・制御文字は使えません。',
  DISPLAY_NAME_TAKEN:
    'この表示名は組織内ですでに使われています。別の名前を入力してください。',
  INSTANCE_CONFLICT: '同じ追加要求の内容が変わっています。一覧を確認してください。',
};
export class OrganizationRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function organizationRequest<T = OrganizationOverview>(
  path: string,
  body: object = {},
): Promise<T> {
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
  const result = (await response.json()) as T & { code?: string; target?: string };
  if (!response.ok)
    throw new OrganizationRequestError(
      (result.target ? `${result.target}：` : '') +
        (errors[result.code ?? ''] ??
          '組織情報を読み込めませんでした。接続設定を確認して再試行してください。'),
      response.status,
    );
  return result;
}

export function useOrganization(enabled = true) {
  const [version, setVersion] = useState(0);
  const [data, setData] = useState<OrganizationOverview | null>(null);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    setLoadFailed(false);
    try {
      setData(await organizationRequest(API_PATHS.organizationOverview));
      setVersion((value) => value + 1);
      return true;
    } catch (error) {
      setLoadFailed(true);
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
          throw new Error('ページを開き直して組織情報を確認してください。');
        body = creationRequest(localStorage, key, (body as { name?: unknown }).name);
      }
      await organizationRequest(path, body);
      const refreshed = await refresh();
      if (!refreshed) {
        setError('保存は完了しましたが一覧を取得できませんでした。再試行してください。');
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
  return { data, error, loadFailed, busy, refresh, mutate, version, moreAccounts };
}
