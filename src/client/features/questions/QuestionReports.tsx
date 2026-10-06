import { useState } from 'react';
import type { QuestionOverview } from '../../../shared/questions';
import Button from '../../components/Button';
import TextField from '../../components/TextField';
import { questionHref } from './pages';

export default function QuestionReports({
  data,
  busy,
  mutate,
  instanceId,
  selectedId,
}: {
  instanceId: string;
  selectedId: string | null;
  data: QuestionOverview;
  busy: boolean;
  mutate: (input: object) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  return (
    <section className="grid gap-4 border border-line p-4">
      <h2 className="text-xl font-bold">通報・再審議</h2>
      <p>
        しきい値に達しても自動停止はしません。必要な場合は問題一覧から使用停止してください。
      </p>
      {selectedId && (
        <TextField
          id="report-resolution"
          label="対応内容・解決理由"
          placeholder="例：根拠を確認し、解説を補足しました"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      )}
      {!data.reviewCases.length && <p>通報はありません。</p>}
      {data.reviewCases
        .filter(
          (review) =>
            !selectedId ||
            `${review.questionId}:${review.kind}:${review.round}` === selectedId,
        )
        .map((review) => {
          const threshold =
            review.kind === 'defect'
              ? data.settings.reportThreshold
              : data.settings.categoryReportThreshold;
          return (
            <div
              key={`${review.questionId}:${review.kind}:${review.round}`}
              className="border border-line p-3"
            >
              <p>
                {data.submissions.find(
                  (submission) => submission.publishedId === review.questionId,
                )?.input.text ??
                  data.reportedOriginals?.[review.questionId]?.text ??
                  (review.questionId.startsWith('original-')
                    ? '持込問題（振り返り期間終了）'
                    : '過去版の問題')}
                ：{review.kind === 'defect' ? '問題不備' : 'カテゴリ違い'} 第
                {review.round}
                回・{review.count}件
              </p>
              <p>
                {review.resolved
                  ? `解決済み：${review.reason}`
                  : review.count >= threshold
                    ? '再審議対象'
                    : '通報を受付中'}
              </p>
              {!selectedId && (
                <a
                  className="underline"
                  href={questionHref(
                    'reports',
                    instanceId,
                    `${review.questionId}:${review.kind}:${review.round}`,
                  )}
                >
                  この通報を確認する
                </a>
              )}
              {selectedId && (
                <p>
                  {data.reportedOriginals?.[review.questionId] &&
                    `答え：${data.reportedOriginals[review.questionId].displayAnswer ?? data.reportedOriginals[review.questionId].answer} ／ ${data.reportedOriginals[review.questionId].explanation}`}
                </p>
              )}
              {selectedId && (
                <ul>
                  {data.reports
                    .filter(
                      (report) =>
                        report.questionId === review.questionId &&
                        report.kind === review.kind &&
                        report.round === review.round,
                    )
                    .map((report) => (
                      <li key={report.id}>
                        {report.reason}
                        {report.suggestedCategory
                          ? `（提案：${report.suggestedCategory}）`
                          : ''}
                      </li>
                    ))}
                </ul>
              )}
              {selectedId && !review.resolved && (
                <Button
                  disabled={busy || !reason.trim()}
                  onClick={() => {
                    void mutate({
                      operation: 'resolve-report',
                      questionId: review.questionId,
                      kind: review.kind,
                      round: review.round,
                      reason,
                    });
                  }}
                >
                  {review.questionId.startsWith('original-')
                    ? '対応を記録して解決する'
                    : '解決して作問者へ通知'}
                </Button>
              )}
            </div>
          );
        })}
    </section>
  );
}
