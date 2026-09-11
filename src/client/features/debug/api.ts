import { isAuthApiError } from '@supabase/supabase-js';
import type { ApiPath } from '../../../shared/api-paths';

export class ProbeApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(
      code === 'UNAUTHORIZED'
        ? '検証トークンを確認してください。クラウド用とローカル用は異なります。'
        : code === 'PROBES_DISABLED'
          ? '検証APIが無効です。有効にしてデプロイしてください。'
          : code === 'AUTH_NOT_CONFIGURED'
            ? 'SupabaseのURLと公開キーを設定してください。'
            : '検証APIでエラーが発生しました。表示されたコードと設定を確認してください。',
    );

    this.status = status;
    this.code = code;
  }
}

export async function probeRequest(token: string, path: ApiPath, method = 'GET') {
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new ProbeApiError(
      response.status,
      typeof data.code === 'string' ? data.code : 'PROBE_FAILED',
    );
  }

  return data;
}

export function formatProbeError(error: unknown) {
  if (error instanceof ProbeApiError) {
    return { ok: false, status: error.status, code: error.code, message: error.message };
  }
  if (isAuthApiError(error)) {
    return {
      ok: false,
      status: error.status,
      code: error.code,
      message:
        error.status === 429
          ? 'Supabaseの認証リクエストが回数制限で拒否されました。連続した再送を止め、時間を置いてください。'
          : '認証に失敗しました。エラーコードとSupabaseの設定を確認してください。',
    };
  }

  return { ok: false, message: '検証に失敗しました。設定と実行手順を確認してください。' };
}
