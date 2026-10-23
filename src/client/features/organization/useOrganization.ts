import { useCallback, useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { OrganizationOverview } from '../../../shared/organization';
import { authToken } from '../auth/client';
import { creationRequest } from './creationRequest';

const errors: Record<string, string> = {
  INVALID_INSTANCE_URL: '開催先のインスタンスURLを入力してください。',
  FEDERATION_DISCOVERY_FAILED:
    '開催先の公開情報を取得できませんでした。URLを確認して再試行してください。',
  FEDERATION_PARTICIPATION_DENIED: '所属元または開催元の参加許可を確認してください。',
  QUESTION_IMPORT_DENIED: '共有元の許可、取り込み先の許可、カテゴリを確認してください。',
  QUESTION_SHARING_DENIED:
    '共有元が問題共有を許可していません。共有カテゴリと相手への許可を確認してください。',
  QUESTION_IMPORT_OVERLAP: '同じ共有元のカテゴリが別の取り込み設定と重なっています。',
  QUESTION_IMPORT_CONFLICT: '取り込み設定が更新されました。一覧を取得し直してください。',
  QUESTION_SYNC_BUSY: '問題を同期しています。少し待って再試行してください。',
  QUESTION_SYNC_UNAVAILABLE:
    '共有元の問題を取得できませんでした。復旧後に再試行してください。',
  QUESTION_SNAPSHOT_CHANGED:
    '取得中に共有元の問題が更新されました。最初から再取得します。',
  FEDERATION_SNAPSHOT_CHANGED:
    '取得中に相手の情報が更新されました。最初から再取得してください。',
  INVALID_SHARED_QUESTIONS:
    '共有元から届いた問題を確認できません。運営者に連絡してください。',
  FEDERATION_CONFLICT: '他の操作で設定が変わりました。一覧を再取得して確認してください。',
  FEDERATION_SYNC_BUSY: '相手の情報を更新しています。少し待って再取得してください。',
  FEDERATION_METADATA_REQUIRED: '相手の情報を取得してから対象を選んでください。',
  PEER_KEY_CONFLICT:
    '登録済みの識別子に別の鍵は保存できません。新しい鍵の識別子を指定してください。',
  INVALID_PEER_ORIGIN:
    '接続先は承認対象のHTTPSサーバーURLを指定してください。パスやポートは指定できません。',
  INVALID_PEER_KEY: '公開鍵と識別子を確認してください。秘密鍵は入力できません。',
  FEDERATION_TARGET_UNAVAILABLE: '接続先の承認と対象インスタンスを確認してください。',
  INVALID_FEDERATION_REQUEST: '連携設定の対象と入力内容を確認してください。',
  INVALID_PERMISSIONS: '連携許可を確認してください。',
  FEDERATION_NOT_CONFIGURED:
    'サーバーの連携URLと署名鍵がまだ設定されていません。設置者が設定してください。',
  UNAPPROVED_PEER: 'この接続先は現在承認されていません。',
  FEDERATION_PEER_UNAVAILABLE:
    '相手サーバーへ接続できませんでした。復旧後に再試行してください。',
  FEDERATION_PEER_RATE_LIMIT:
    '相手サーバーの受付上限に達しました。しばらく待って再試行してください。',
  FEDERATION_METADATA_INVALID:
    '相手の情報を確認できませんでした。運営者に連絡してください。',
  ROOM_INVENTORY_REQUIRED:
    '過去の対戦部屋の確認が完了していません。設置者による確認が必要です。',
  RESULT_OR_MATCH_PENDING:
    '進行中の試合、または未保存の結果があります。保存完了後に再試行してください。',
  DELETION_PENDING: '削除の完了を確認できませんでした。同じ内容で再試行してください。',
  INSTANCE_DELETING: 'このインスタンスは完全削除の処理中です。',
  ACCOUNT_WITHDRAWN: 'このアカウントは退会済みです。',
  WITHDRAWAL_CONFIRMATION: '確認欄に「退会」と入力してください。',
  WITHDRAWAL_ACCOUNT_CHANGED:
    'ログイン中のアカウントが変わりました。マイページから手続きを開き直してください。',
  LAST_ADMINISTRATOR: '先に別のユーザーへの管理者引き継ぎを完了してください。',
  CANCEL_WAITING_FIRST: '先に対戦待機を取り消してください。',
  MATCH_STARTED: '試合が終了してから退会手続きをしてください。',
  WITHDRAWAL_PENDING:
    '別の退会手続きの処理中です。最初に開いた画面で再試行してください。',
  ERASURE_UNAVAILABLE: '現在、消去処理を利用できません。時間を置いて再試行してください。',
  INVALID_OPERATION: '操作内容を確認してください。',
  INVALID_INSTANCE: '対象のインスタンスを確認してください。',
  INSTANCE_NOT_FOUND: 'このインスタンスは現在利用できません。一覧を更新してください。',
  RANKED_PAUSED: 'このインスタンスはランクの受付を停止しています。',
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
  STALE_REQUEST: '参加要求が更新されました。もう一度お試しください。',
  STALE_RESERVATION:
    'この参加予約は終了しました。開催先へ戻って、改めて参加してください。',
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
    public code = '',
  ) {
    super(message);
  }
}
export async function organizationRequest<T = OrganizationOverview>(
  path: string,
  body: object = {},
): Promise<T> {
  const token = await authToken();
  if (!token) throw new Error('ログインしてください。');
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
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
      result.code ?? '',
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
