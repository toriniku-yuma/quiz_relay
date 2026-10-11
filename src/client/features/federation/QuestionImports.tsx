import { useState } from 'react';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import QuestionImportForm from './QuestionImportForm';
import type { useQuestionSharing } from './useQuestionSharing';

export default function QuestionImports({
  sharing,
}: {
  sharing: ReturnType<typeof useQuestionSharing>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const current = sharing.data?.imports.find((row) => row.id === selected);
  return (
    <Panel title="他のインスタンスから受け取る問題">
      {!sharing.data?.imports.length && (
        <p className="my-3">受け取り元はまだ設定されていません。</p>
      )}
      <ul className="my-4 grid gap-4">
        {sharing.data?.imports.map((job) => (
          <li key={job.id} className="grid gap-3 border border-line p-3">
            <p className="break-words">
              <strong>
                {sharing.data?.sources.find(
                  (source) =>
                    source.peerOrigin === job.peerOrigin &&
                    source.instanceId === job.sourceInstanceId,
                )?.name ?? job.peerOrigin}
              </strong>
            </p>
            <p>
              受け取る範囲：
              {job.config.categories.length
                ? job.config.categories
                    .map(
                      (id) =>
                        sharing.data?.sourceCategories.find(
                          (category) =>
                            category.id === id &&
                            category.peerOrigin === job.peerOrigin &&
                            category.sourceInstanceId === job.sourceInstanceId,
                        )?.name ?? 'カテゴリ名を取得中',
                    )
                    .join('、')
                : '全カテゴリ'}
            </p>
            <p>
              保存先：
              {sharing.data?.categories.find(
                (category) => category.id === job.config.targetCategoryId,
              )?.name ?? '保存先が利用できません'}
            </p>
            <p role="status">
              {!job.enabled
                ? '利用停止中'
                : job.errorCode
                  ? '取得できません。時間をおいて自動で再試行します。'
                  : job.syncing
                    ? '取り込み中'
                    : job.lastSuccessAt
                      ? '利用中・自動更新'
                      : '取り込み待ち'}
            </p>
            <Button disabled={sharing.busy} onClick={() => setSelected(job.id)}>
              受け取る範囲・保存先を変更
            </Button>
          </li>
        ))}
      </ul>
      {selected === null ? (
        <Button disabled={sharing.busy} onClick={() => setSelected('')}>
          受け取り元を追加
        </Button>
      ) : (
        <QuestionImportForm
          key={selected}
          sharing={sharing}
          initial={current}
          onSaved={() => setSelected(null)}
          onCancel={() => setSelected(null)}
        />
      )}
      <p className="my-3 text-sm">
        別々のカテゴリへ保存する場合は、同じ共有元を追加し、それぞれ受け取るカテゴリと保存先を指定してください。
      </p>
    </Panel>
  );
}
