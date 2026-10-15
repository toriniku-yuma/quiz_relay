import { API_PATHS, instanceApiPath } from '../../../shared/api-paths';
import { authToken } from '../auth/client';

const errors: Record<string, string> = {
  PROFILE_REQUIRED: 'マイページで表示名を登録してから参加してください。',
  PARTICIPATION_RESTRICTED:
    '利用が制限されています。マイページで理由・期限を確認してください。',
  LOGOUT_PENDING: 'ログアウト処理を確認しています。ログアウトを再実行してください。',
  RANKED_NOT_CONFIGURED: '出題設定が未登録です。運営者による設定をお待ちください。',
  STALE_RESERVATION:
    '参加状態を確認できませんでした。「参加中の試合へ戻る」で再確認してください。',
  NO_RANKED_QUESTIONS:
    '出題できる問題がないため受付を停止しています。問題が復旧したら、改めてマッチングしてください。',
  GAME_DATABASE_UNAVAILABLE:
    '大会設定を読み込めませんでした。しばらく待って再試行してください。',
  INSTANCE_PREPARING: 'このインスタンスは準備中です。',
  RANKED_PAUSED: 'このインスタンスはランクの受付を停止しています。',
  INSTANCE_NOT_FOUND: 'このインスタンスを利用できません。',
  OTHER_INSTANCE_ACTIVE:
    '別のインスタンスで参加中です。元のインスタンスへ戻ってください。',
  AUTH_REQUIRED: 'ログインし直してください。',
  ALREADY_JOINED: 'すでに参加中です。「参加中の試合へ戻る」を押してください。',
  NO_ACTIVE_MATCH: '参加中の試合はありません。',
  MATCH_STARTED: '試合が始まったため、待機を取り消せません。',
  STALE_REQUEST: 'この参加要求は失効しました。必要ならもう一度マッチングしてください。',
  STALE_ROOM: '参加中の試合が変わりました。画面を読み込み直してください。',
  ROOM_CLOSED: '待機が終了しました。もう一度マッチングしてください。',
  MATCHMAKING_FULL: '現在の参加枠が満員です。しばらく待ってください。',
  RATE_LIMIT: '操作が多いため、少し待ってからお試しください。',
  MATCH_SWITCH_PENDING:
    '前の参加からの離脱を確認しています。少し待って再試行してください。',
  OPERATION_CONFLICT: '再試行の内容が変わっています。参加状態を確認してください。',
};
export class MatchError extends Error {
  constructor(
    readonly code: string,
    readonly instanceId?: string,
    readonly status = 409,
    readonly mode?: 'ranked' | 'casual' | 'room',
    readonly room?: string,
  ) {
    super(
      errors[code] ??
        '参加処理を完了できませんでした。しばらく待って再試行してください。',
    );
  }
}
export async function matchRequest(path: string, body: object = {}, instanceId = '') {
  const token = await authToken();
  if (!token) throw new MatchError('AUTH_REQUIRED');
  const response = await fetch(instanceApiPath(path, instanceId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const result = (await response.json()) as {
    room?: string;
    operationId?: string;
    instanceId?: string;
    code?: string;
    mode?: 'ranked' | 'casual' | 'room';
    playersPerMatch?: number;
    rules?: { correctAnswersToWin: number; mistakesToDisqualify: number };
  };
  if (!response.ok)
    throw new MatchError(
      result.code ?? 'MATCH_FAILED',
      result.instanceId,
      response.status,
      result.mode,
      result.room,
    );
  return result;
}
export const resumeMatch = (instanceId = '') =>
  matchRequest(API_PATHS.matchResume, {}, instanceId);
