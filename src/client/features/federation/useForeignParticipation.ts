import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import {
  type ForeignSession,
  type ParticipationTarget,
  participationId,
  participationOrigin,
} from '../../../shared/participation';
import { PlayRequestError, playMessages } from '../rooms/api';
import { beginForeignAuthorization } from './redirect';

const storageKey = 'quiz-relay-foreign-reservation';
type Recovery = {
  reservationId: string;
  operationId: string;
  target: ParticipationTarget;
};
function readRecovery(): Recovery | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(storageKey) ?? 'null',
    ) as Recovery | null;
    if (
      !value ||
      !participationId(value.reservationId) ||
      !participationId(value.operationId) ||
      !participationOrigin(value.target?.peerOrigin) ||
      !participationId(value.target.sourceOrganizationId) ||
      !participationId(value.target.hostInstanceId) ||
      !['ranked', 'casual', 'room'].includes(value.target.mode)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
function saveRecovery(value: Recovery | null) {
  try {
    if (value) localStorage.setItem(storageKey, JSON.stringify(value));
    else localStorage.removeItem(storageKey);
  } catch {
    /* Browser storage is optional; the HttpOnly cookie authorizes the live session. */
  }
}
const messages: Record<string, string> = {
  SESSION_REQUIRED: '参加セッションがありません。所属元で本人確認を行ってください。',
  STALE_RESERVATION: 'この参加予約は終了しました。改めて参加してください。',
  PARTICIPATION_RESTRICTED: '現在、この対戦への参加が制限されています。',
  FEDERATION_PARTICIPATION_DENIED: 'この対戦への連携参加は現在許可されていません。',
  MATCH_STARTED: '試合が始まっています。離脱する場合は「試合から離脱」を選んでください。',
  FEDERATION_NOT_CONFIGURED: 'このサーバーの連携設定がまだ完了していません。',
  PARTICIPATION_TICKET_REJECTED:
    'ログインの証明を確認できませんでした。所属元から開き直してください。',
  PARTICIPATION_TICKET_BINDING:
    'ログイン中のアカウントと参加の証明が一致しません。所属元から開き直してください。',
  PARTICIPATION_LOGOUT_PENDING:
    'ログアウトの完了を確認できません。もう一度ログアウトしてください。',
  RATE_LIMIT: '操作が多いため、少し待ってから再試行してください。',
};
export async function foreignRequest<T>(
  path: string,
  body: object = {},
  reservationId = '',
): Promise<T> {
  const url = new URL(path, location.origin);
  if (reservationId) url.searchParams.set('reservation', reservationId);
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
  const result = (await response.json()) as T & { code?: string };
  if (!response.ok)
    throw new PlayRequestError(
      messages[result.code ?? ''] ??
        playMessages[result.code ?? ''] ??
        '参加を確認できませんでした。時間を置いて再試行してください。',
      response.status,
      result.code ?? '',
    );
  return result;
}
export function useForeignParticipation(ready: boolean) {
  const [session, setSession] = useState<ForeignSession | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(readRecovery);
  const revision = useRef(0);
  const endSession = useCallback(() => {
    revision.current++;
    saveRecovery(null);
    setRecovery(null);
    setSession(null);
    setBusy(false);
    setError('');
  }, []);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const id = readRecovery()?.reservationId,
      generation = ++revision.current;
    if (participationId(id)) {
      setBusy(true);
      void foreignRequest<ForeignSession>(API_PATHS.participationResume, {}, id)
        .then((value) => {
          if (active && revision.current === generation) setSession(value);
        })
        .catch((error) => {
          if (!active || revision.current !== generation) return;
          if (error instanceof PlayRequestError && [401, 409].includes(error.status)) {
            if (readRecovery()?.reservationId === id) saveRecovery(null);
            setRecovery(null);
          }
          setError(error instanceof Error ? error.message : messages.SESSION_REQUIRED);
        })
        .finally(() => {
          if (active && revision.current === generation) setBusy(false);
        });
    }
    return () => {
      active = false;
      revision.current++;
    };
  }, [ready]);
  async function cancel(forfeit: boolean) {
    if (!session) return;
    revision.current++;
    setBusy(true);
    setError('');
    try {
      await foreignRequest(
        API_PATHS.participationCancel,
        { forfeit },
        session.reservationId,
      );
      saveRecovery(null);
      setRecovery(null);
      setSession(null);
    } catch (error) {
      if (error instanceof PlayRequestError && error.code === 'SESSION_REQUIRED') {
        saveRecovery(null);
        setRecovery(null);
        setSession(null);
        return;
      }
      setError(error instanceof Error ? error.message : '取消を確認できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  const exchange = useCallback(async (ticket: string, target: ParticipationTarget) => {
    const generation = ++revision.current;
    setBusy(true);
    setError('');
    try {
      const result = await foreignRequest<{ reservationId: string }>(
        API_PATHS.participationExchange,
        { ticket },
      );
      const session = await foreignRequest<ForeignSession>(
        API_PATHS.participationSession,
        {},
        result.reservationId,
      );
      if (revision.current !== generation) return;
      if (
        session.homeOrigin !== target.peerOrigin ||
        session.sourceOrganizationId !== target.sourceOrganizationId ||
        session.instanceId !== target.hostInstanceId ||
        session.mode !== target.mode
      )
        throw new Error(messages.PARTICIPATION_TICKET_BINDING);
      const saved = {
        reservationId: session.reservationId,
        operationId: session.operationId,
        target,
      };
      saveRecovery(saved);
      setRecovery(saved);
      setSession(session);
    } catch (error) {
      if (revision.current === generation)
        setError(error instanceof Error ? error.message : '参加を確認できません。');
      throw error;
    } finally {
      if (revision.current === generation) setBusy(false);
    }
  }, []);
  function join(target: ParticipationTarget) {
    const operation =
      recovery && JSON.stringify(recovery.target) === JSON.stringify(target)
        ? recovery.operationId
        : crypto.randomUUID();
    try {
      beginForeignAuthorization(target, 'participation', operation);
    } catch {
      setError('本人確認の保存に失敗しました。ブラウザーの保存設定を確認してください。');
    }
  }
  return {
    session,
    error,
    busy,
    cancel,
    endSession,
    recoveryTarget: recovery?.target,
    exchange,
    join,
  };
}
