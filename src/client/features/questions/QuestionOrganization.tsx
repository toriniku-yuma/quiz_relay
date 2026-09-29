import { useState } from 'react';
import type { QuestionOverview } from '../../../shared/questions';
import Button from '../../components/Button';
import TextField from '../../components/TextField';
import { type QuestionPage, questionHref } from './pages';
export default function QuestionOrganization({
  data,
  busy,
  mutate,
  page,
  instanceId,
  selectedId,
}: {
  page: QuestionPage;
  instanceId: string;
  selectedId: string | null;
  data: QuestionOverview;
  busy: boolean;
  mutate: (body: object) => Promise<boolean>;
}) {
  const [reason, setReason] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  return (
    <section className="grid gap-3 border border-line p-4">
      <div className="grid gap-3">
        {page === 'categoryRequests' &&
          data.categoryRequests
            .filter((request) => !selectedId || request.submissionId === selectedId)
            .map((request) => {
              const row = data.submissions.find(
                (item) => item.id === request.submissionId,
              );
              if (!row) return null;
              return (
                <div key={row.id} className="border border-line p-3">
                  <p>
                    カテゴリ変更申請：{row.input.text} →{' '}
                    {data.categories.find((item) => item.id === request.categoryId)?.name}
                  </p>
                  <p>{request.reason}</p>
                  {!selectedId ? (
                    <a
                      className="underline"
                      href={questionHref('categoryRequests', instanceId, row.id)}
                    >
                      この申請を審査する
                    </a>
                  ) : (
                    <>
                      <TextField
                        id={`category-resolution-${row.id}`}
                        label="申請を見送る理由"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                      <Button
                        disabled={busy}
                        onClick={() => {
                          void mutate({
                            operation: 'classify',
                            changes: [
                              {
                                id: row.id,
                                revision: row.revision,
                                categoryId: request.categoryId,
                              },
                            ],
                          });
                        }}
                      >
                        申請したカテゴリへ変更
                      </Button>
                      <Button
                        disabled={busy || !reason.trim()}
                        onClick={() => {
                          void mutate({
                            operation: 'reject-category',
                            id: row.id,
                            revision: row.revision,
                            reason,
                          });
                        }}
                      >
                        理由を記録して見送る
                      </Button>
                    </>
                  )}
                </div>
              );
            })}
        {page === 'tags' && (
          <>
            <TextField
              id="tag-from"
              label="統合するタグの旧名"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
            <TextField
              id="tag-to"
              label="統合先の既存タグ名"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
            <Button
              disabled={busy || !from || !to}
              onClick={() => {
                void mutate({ operation: 'merge-tags', from, to });
              }}
            >
              旧名を別名として残して統合
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
