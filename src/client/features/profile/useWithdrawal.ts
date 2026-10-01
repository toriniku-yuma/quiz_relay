import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { setupAuth } from '../auth/client';
import {
  OrganizationRequestError,
  organizationRequest,
} from '../organization/useOrganization';
import { readWithdrawalReceipt, withdrawalReceiptKey } from './withdrawalReceipt';

export function useWithdrawal(subject?: string) {
  const [receipt, setReceipt] = useState(() => readWithdrawalReceipt(subject));
  const [confirmation, setConfirmation] = useState(receipt ? '退会' : '');
  const [accepted, setAccepted] = useState(false),
    [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const sending = useRef(false);
  const status = useCallback(
    async (request: { id: string; subject: string }, signal?: AbortSignal) => {
      const response = await fetch(API_PATHS.withdrawalStatus, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: request.id }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error('退会の処理状況を確認できませんでした。再試行してください。');
      const value = (await response.json()) as { accepted: boolean; ready: boolean };
      signal?.throwIfAborted();
      if (value.accepted) {
        setAccepted(true);
        setReady(value.ready);
        // Application access is already revoked on the server; discard this browser's Auth token.
        const client = await setupAuth();
        const { data } = await client.auth.getSession();
        if (data.session?.user.id === request.subject)
          await client.auth.signOut({ scope: 'local' });
      }
      return value.accepted;
    },
    [],
  );
  useEffect(() => {
    if (!receipt || ready) return;
    const controller = new AbortController();
    let stopped = false;
    const check = async () => {
      try {
        await status(receipt, controller.signal);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : '通信に失敗しました。');
      }
    };
    void check();
    const interval = window.setInterval(() => {
      if (!stopped) void check();
    }, 15000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [receipt, ready, status]);
  async function submit() {
    if (sending.current || confirmation !== '退会' || (!receipt && !subject)) return;
    sending.current = true;
    setBusy(true);
    setError('');
    const request = receipt ?? { id: crypto.randomUUID(), subject: subject ?? '' };
    try {
      try {
        sessionStorage.setItem(withdrawalReceiptKey, JSON.stringify(request));
      } catch {
        throw new Error(
          '退会手続きの保存に失敗しました。ブラウザーの保存領域を確認して再試行してください。',
        );
      }
      setReceipt(request);
      if (!(await status(request))) {
        await organizationRequest(API_PATHS.accountWithdrawal, {
          operationId: request.id,
          confirmation: '退会',
          subject: request.subject,
        });
        await status(request);
      }
    } catch (e) {
      if (
        e instanceof OrganizationRequestError &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 408
      ) {
        setReceipt(null);
        try {
          sessionStorage.removeItem(withdrawalReceiptKey);
        } catch {
          // The server rejected this request; keep the error visible even when storage is unavailable.
        }
      }
      setError(e instanceof Error ? e.message : '退会結果を確認できませんでした。');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return {
    confirmation,
    setConfirmation,
    accepted,
    ready,
    busy,
    error,
    locked: !!receipt,
    submit,
  };
}
