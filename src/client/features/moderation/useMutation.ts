import { useRef, useState } from 'react';
import {
  OrganizationRequestError,
  organizationRequest,
} from '../organization/useOrganization';
export function useMutation(
  path: string,
  onSaved: (request: Record<string, unknown>) => void | Promise<void>,
) {
  const pending = useRef<Record<string, unknown> | null>(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState('');
  async function submit(input: Record<string, unknown>) {
    if (sending.current) return;
    const request = pending.current ?? { ...input, operationId: crypto.randomUUID() };
    pending.current = request;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await organizationRequest(path, request);
      pending.current = null;
      setUncertain(false);
      window.dispatchEvent(new Event('notifications:refresh'));
      try {
        await onSaved(request);
      } catch {
        setError('保存しましたが表示を更新できませんでした。再読み込みしてください。');
      }
    } catch (e) {
      const rejected =
        e instanceof OrganizationRequestError &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 408;
      if (rejected) pending.current = null;
      setUncertain(!rejected);
      setError(e instanceof Error ? e.message : '保存結果を確認できませんでした。');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return { submit, busy, uncertain, error };
}
