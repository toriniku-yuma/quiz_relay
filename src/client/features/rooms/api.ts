import { instanceApiPath } from '../../../shared/api-paths';
import { setupAuth } from '../auth/client';
import { OrganizationRequestError } from '../organization/useOrganization';

const messages: Record<string, string> = {
  CASUAL_DISABLED: 'カジュアルマッチは無効です。',
  CASUAL_PAUSED: 'カジュアルマッチ・部屋の受付を停止しています。',
  GUEST_NOT_ALLOWED: 'ゲスト参加は許可されていません。',
  GUEST_REQUIRED: 'ゲスト名を登録してください。',
  ROOM_HOST_REQUIRED: '部屋主だけが操作できます。',
  ROOM_NOT_READY: '接続中の回答者2人以上の準備完了が必要です。',
  PASSWORD_INCORRECT: 'パスワードが違います。',
  ROOM_FULL: '部屋が満員です。',
  ROOM_CLOSED: 'この部屋は閉じています。',
  INVITE_REQUIRED: '有効な招待が必要です。',
  ROOM_NOT_FOUND: 'この部屋を利用できません。',
  NO_ROOM_QUESTIONS: '条件に合う出題可能な問題がありません。',
  NO_RANKED_QUESTIONS: '出題可能な問題がありません。',
  RANKED_NOT_CONFIGURED: '出題設定を確認できません。',
  NO_ACTIVE_MATCH: '参加中の試合はありません。',
  OTHER_INSTANCE_ACTIVE: '別の対戦・部屋で参加中です。参加先へ戻ってください。',
  START_PENDING: '開始の結果を確認しています。同じ操作で再試行してください。',
  EDIT_CONFLICT: '設定が変わりました。ページを開き直してください。',
  OPERATION_CONFLICT: '再試行の内容が変わっています。',
  PARTICIPATION_RESTRICTED: '参加が制限されています。マイページを確認してください。',
  LOGIN_REQUIRED: 'ログインが必要です。',
  AUTH_REQUIRED: 'ログインし直してください。',
  INVALID_SETUP: '入力内容を確認してください。',
  REPORT_NOT_ALLOWED: 'この対象には通報できません。',
  ALREADY_REPORTED: 'この問題はすでに通報済みです。',
  MATCH_STARTED: '進行中の試合が終わるまでお待ちください。',
  MATCH_SWITCH_PENDING:
    '前の参加からの離脱を確認しています。少し待って再試行してください。',
};
export class PlayRequestError extends OrganizationRequestError {
  constructor(
    message: string,
    status: number,
    readonly code: string,
    readonly instanceId?: string,
    readonly mode?: 'ranked' | 'casual' | 'room',
  ) {
    super(message, status);
  }
}
export async function playRequest<T>(
  path: string,
  body: object = {},
  instanceId = '',
  signal?: AbortSignal,
): Promise<T> {
  const auth = await setupAuth(),
    { data } = await auth.auth.getSession();
  const response = await fetch(instanceApiPath(path, instanceId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
  });
  const result = (await response.json()) as T & {
    code?: string;
    instanceId?: string;
    mode?: 'ranked' | 'casual' | 'room';
  };
  if (!response.ok)
    throw new PlayRequestError(
      messages[result.code ?? ''] ??
        '操作を完了できませんでした。入力または通信状態を確認してください。',
      response.status,
      result.code ?? '',
      result.instanceId,
      result.mode,
    );
  return result;
}
