import { useRef, useState } from 'react';
import { QuestionRequestError, questionsRequest } from './useQuestions';
export function useQuestionOperation(instanceId: string, saved: () => Promise<void>) {
  const [pending, setPending] = useState<object | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const sending = useRef(false);
  async function submit(input: object) {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    setError('');
    const body = pending ?? input;
    setPending(body);
    try {
      await questionsRequest(instanceId, body);
      try {
        await saved();
      } catch {
        setError('保存しましたが一覧を更新できませんでした。再読み込みしてください。');
        return false;
      }
      setPending(null);
      return true;
    } catch (e) {
      if (e instanceof QuestionRequestError && e.status < 500 && e.status !== 408)
        setPending(null);
      setError(e instanceof Error ? e.message : '保存できませんでした。');
      return false;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return { submit, error, busy, uncertain: !!pending };
}
