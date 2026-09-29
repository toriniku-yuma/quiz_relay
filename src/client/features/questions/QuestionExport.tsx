import { useState } from 'react';
import { exportTransfer, type TransferQuestion } from '../../../shared/question-transfer';
import Button from '../../components/Button';
import Modal from '../../components/Modal';
import { questionsRequest } from './useQuestions';
export default function QuestionExport({
  instanceId,
  ids,
  onClose,
}: {
  instanceId: string;
  ids: string[];
  onClose: () => void;
}) {
  const [all, setAll] = useState(!ids.length),
    [files, setFiles] = useState<{ name: string; content: string }[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title="問題のエクスポート" onClose={onClose} busy={busy}>
      <div className="grid gap-4">
        <label>
          <input
            className="size-6 align-middle accent-accent"
            type="radio"
            name="export-scope"
            checked={!all}
            disabled={!ids.length || busy}
            onChange={() => {
              setAll(false);
              setFiles([]);
            }}
          />{' '}
          選択した問題（{ids.length}件）
        </label>
        <label>
          <input
            className="size-6 align-middle accent-accent"
            type="radio"
            name="export-scope"
            checked={all}
            disabled={busy}
            onChange={() => {
              setAll(true);
              setFiles([]);
            }}
          />{' '}
          インスタンス全体
        </label>
        <p>
          {all
            ? '承認済みの問題を出力します。使用停止中を含み、削除済みは除きます。'
            : '選択した問題を、状態にかかわらず出力します。'}
          作問者名・出力元・停止状態を保持します。
        </p>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const data = await questionsRequest<{ questions: TransferQuestion[] }>(
                instanceId,
                { operation: 'export-managed', all, ids },
              );
              setFiles(
                exportTransfer(data.questions).map((content, index) => ({
                  name: `questions-${index + 1}.json`,
                  content,
                })),
              );
              if (!data.questions.length) setError('出力できる問題がありません。');
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          JSONを作成
        </Button>
        {error && <p role="alert">{error}</p>}
        {files.map((file, i) => (
          <a
            className="underline"
            key={file.name}
            download={file.name}
            href={`data:application/json;charset=utf-8,${encodeURIComponent(file.content)}`}
          >
            JSON {i + 1}を保存
          </a>
        ))}
      </div>
    </Modal>
  );
}
