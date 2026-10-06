import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { exportQuestionJson } from '../../../shared/question-json';
import type { QuestionInput } from '../../../shared/questions';
import { useMutation } from '../moderation/useMutation';
import { questionsRequest } from '../questions/useQuestions';

export function useClosure(instanceId: string, refresh: () => Promise<boolean>) {
  const [confirm, setConfirm] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mutation = useMutation(API_PATHS.organizationOperation, async () => {
    setConfirm(false);
    if (!(await refresh())) throw new Error('REFRESH_FAILED');
  });
  async function exportMine() {
    setBusy(true);
    setError('');
    setFiles([]);
    try {
      const result = await questionsRequest<{ questions: QuestionInput[] }>(instanceId, {
        operation: 'export',
      });
      setFiles(exportQuestionJson(result.questions));
      if (!result.questions.length) setError('出力できる問題がありません。');
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : '出力できませんでした。',
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    mutation,
    confirm,
    setConfirm,
    exportOpen,
    setExportOpen,
    files,
    busy,
    error,
    exportMine,
  };
}
