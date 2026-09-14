import { API_PATHS } from '../../../shared/api-paths';
import { setupAuth } from '../auth/client';

const errors: Record<string, string> = {
  GAME_DATABASE_UNAVAILABLE:
    '大会設定を読み込めませんでした。しばらく待って再試行してください。',
  AUTH_REQUIRED: 'ログインし直してください。',
  ALREADY_JOINED: 'すでに参加中です。「参加中の試合へ戻る」を押してください。',
  NO_ACTIVE_MATCH: '参加中の試合はありません。',
  MATCH_STARTED: '試合が始まったため、待機を取り消せません。',
  STALE_REQUEST: 'この参加要求は失効しました。必要ならもう一度マッチングしてください。',
  STALE_ROOM: '参加中の試合が変わりました。画面を読み込み直してください。',
  ROOM_CLOSED: '待機が終了しました。もう一度マッチングしてください。',
  MATCHMAKING_FULL: '現在の参加枠が満員です。しばらく待ってください。',
  RATE_LIMIT: '操作が多いため、少し待ってからお試しください。',
};
export class MatchError extends Error {
  constructor(readonly code: string) {
    super(
      errors[code] ??
        '参加処理を完了できませんでした。しばらく待って再試行してください。',
    );
  }
}
export async function matchRequest(path: string, body: object = {}) {
  const client = await setupAuth();
  const { data } = await client.auth.getSession();
  if (!data.session) throw new MatchError('AUTH_REQUIRED');
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const result = (await response.json()) as {
    room?: string;
    code?: string;
    playersPerMatch?: number;
    rules?: { correctAnswersToWin: number; mistakesToDisqualify: number };
  };
  if (!response.ok) throw new MatchError(result.code ?? 'MATCH_FAILED');
  return result;
}
export const resumeMatch = () => matchRequest(API_PATHS.matchResume);
