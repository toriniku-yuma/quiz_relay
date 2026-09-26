import { useState } from 'react';
import { exportQuestionJson, parseQuestionJson } from '../../../shared/question-json';
import {
  canSubmitQuestion,
  questionPageSizes,
  type Submission,
  statusLabels,
  validateQuestionInput,
} from '../../../shared/questions';
import { navigate } from '../../app/navigation';
import Button from '../../components/Button';
import TextField from '../../components/TextField';
import {
  canOpenQuestionPage,
  type QuestionPage,
  questionHref,
  questionListHref,
  questionListState,
  questionManagementGroups,
  questionPages,
  questionReturnHref,
} from './pages';
import QuestionAdministration from './QuestionAdministration';
import QuestionCategoryRequest from './QuestionCategoryRequest';
import QuestionEditor from './QuestionEditor';
import QuestionOrganization from './QuestionOrganization';
import QuestionReports from './QuestionReports';
import QuestionSelectionSettings from './QuestionSelectionSettings';
import { questionsRequest, useQuestions } from './useQuestions';

export default function QuestionWorkspace({
  instanceId,
  page,
  selectedId,
  search = '',
}: {
  instanceId: string;
  page: QuestionPage;
  selectedId: string | null;
  search?: string;
}) {
  const creating = page === 'new';
  const reviewing = page === 'review' || page === 'pending' || page === 'decision';
  const listing = page === 'mine' || page === 'review' || page === 'pending';
  const managementPage = questionManagementGroups.some((group) =>
    group.pages.some((target) => target === page),
  );
  const listState = questionListState(search);
  const { query, status, category, page: listPage, pageSize } = listState;
  function updateList(change: Partial<typeof listState>) {
    if (listing)
      navigate(
        questionListHref(page, instanceId, { ...listState, page: 1, ...change }),
        true,
      );
  }
  const listHref = listing
    ? questionListHref(page, instanceId, {
        query,
        status,
        category,
        page: listPage,
        pageSize,
      })
    : undefined;
  const returnHref = questionReturnHref(search, instanceId);
  const href = (target: QuestionPage, id?: string) => {
    const destination = questionHref(target, instanceId, id);
    const back = listHref ?? returnHref;
    return back && ['new', 'edit', 'decision', 'categoryRequest'].includes(target)
      ? `${destination}&return=${encodeURIComponent(back)}`
      : destination;
  };
  const model = useQuestions(
    instanceId,
    true,
    listing
      ? {
          scope: page === 'mine' ? 'mine' : page === 'pending' ? 'pending' : 'all',
          page: listPage,
          pageSize,
          query,
          status,
          category,
        }
      : undefined,
    !listing && page !== 'management' ? { page, id: selectedId } : undefined,
  );
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<
    | {
        id: string;
        action: string;
        reason: string;
        revision: number;
        input: Submission['input'];
      }[]
    | null
  >(null);
  const data = model.data;
  const resultsReady = !!data && !model.stale && !model.busy && !model.loadFailed;
  const pagination = resultsReady ? data?.pagination : undefined;
  const currentPage = pagination?.page ?? listPage;
  const total = pagination?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const selected = data?.submissions.find(
    (row) =>
      row.id === selectedId &&
      (reviewing || page === 'categoryRequests' || row.authorId === data.actorId),
  );
  const canSubmit =
    data && canSubmitQuestion(data.settings.mode, data.administrator, data.qualified);
  async function action(operation: string) {
    if (!selected) return;
    if (operation === 'submit') {
      const checked = validateQuestionInput(selected.input, true);
      if (checked.issues.length) {
        model.setError(
          checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'),
        );
        return;
      }
    }
    if (
      await model.mutate({
        operation,
        id: selected.id,
        revision: selected.revision,
        reason,
      })
    ) {
      setReason('');
      setHistory(null);
    }
  }
  const filtered = resultsReady
    ? data?.submissions.filter(
        (row) =>
          (page !== 'mine' || row.authorId === data.actorId) &&
          (page !== 'pending' || row.status === 'pending'),
      )
    : undefined;
  if (data && !canOpenQuestionPage(page, data))
    return <p role="alert">このページを利用する権限がありません。</p>;
  return (
    <div className="grid gap-6">
      {managementPage && (
        <a className="underline" href={href('management')}>
          問題管理に戻る
        </a>
      )}
      {!listing && (!managementPage || selectedId) && (
        <a
          className="underline"
          href={
            returnHref ??
            href(
              selectedId &&
                ['authors', 'categories', 'reports', 'categoryRequests'].includes(page)
                ? page
                : questionPages[page].path.startsWith('/question-review/') &&
                    page !== 'authors'
                  ? 'review'
                  : 'mine',
            )
          }
        >
          一覧に戻る
        </a>
      )}
      {data &&
        selectedId &&
        ['edit', 'decision', 'categoryRequest'].includes(page) &&
        !selected && <p role="alert">対象の問題がないか、閲覧する権限がありません。</p>}

      {model.error && (
        <p role="alert" className="whitespace-pre-wrap border border-accent p-4">
          {model.error}
        </p>
      )}
      {model.message && <p role="status">{model.message}</p>}
      {model.loadFailed && (
        <Button disabled={model.busy} onClick={() => void model.refresh()}>
          再試行
        </Button>
      )}
      {data && (
        <p>
          投稿方式：
          {
            {
              admin: '管理者限定',
              qualified: '承認作問者限定',
              review: '一般投稿・審査あり',
              open: '一般投稿・審査なし',
            }[data.settings.mode]
          }
          。公開済みは「対戦で出題可能」を意味します。
        </p>
      )}
      {!data && !listing && !creating && page !== 'import' && (
        <section className="border border-line p-4" aria-busy={!model.loadFailed}>
          <h2 className="mb-3 text-xl font-bold">{questionPages[page].title}</h2>
          <p role="status">
            {model.loadFailed
              ? '必要な情報を取得できませんでした。'
              : '必要な情報を読み込んでいます。'}
          </p>
        </section>
      )}
      {page === 'mine' && (
        <div className="flex flex-wrap gap-3">
          {canSubmit && (
            <a className="font-bold underline" href={href('new')}>
              新しい問題を作る
            </a>
          )}
          <a className="underline" href={href('import')}>
            JSON取込
          </a>
          <a className="underline" href={href('qualification')}>
            作問者資格の申請
          </a>
          <Button
            disabled={model.busy || !data}
            onClick={async () => {
              try {
                const result = await questionsRequest<{
                  questions: Submission['input'][];
                }>(instanceId, { operation: 'export' });
                for (const [index, contents] of exportQuestionJson(
                  result.questions,
                ).entries()) {
                  const blob = new Blob([contents], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = `my-questions-${index + 1}.json`;
                  anchor.click();
                  setTimeout(() => URL.revokeObjectURL(url), 10000);
                }
              } catch (e) {
                model.setError(e instanceof Error ? e.message : '出力できませんでした。');
              }
            }}
          >
            自作問題をJSON出力
          </Button>
        </div>
      )}
      {page === 'import' && (
        <label className="grid gap-2">
          JSONを下書きとして取り込む（500問・2MB以内）
          <input
            type="file"
            accept=".json,application/json"
            disabled={!canSubmit || model.busy}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try {
                if (file.size > 2000000)
                  throw new Error('2MB以内のファイルを選んでください。');
                const source = await file.text();
                parseQuestionJson(source);
                await model.mutate({
                  operation: 'import',
                  requestId: crypto.randomUUID(),
                  source,
                });
              } catch (e) {
                model.setError(e instanceof Error ? e.message : '読み込めませんでした。');
              }
              event.target.value = '';
            }}
          />
        </label>
      )}
      {listing && (
        <section className="grid gap-4 border border-line p-4">
          <h2 className="text-xl font-bold">
            {page === 'pending'
              ? '審査待ちの問題'
              : reviewing
                ? '問題一覧'
                : '自分の問題'}
          </h2>
          <TextField
            id="question-search"
            label="問題文・正答・読み・タグで検索"
            placeholder="例：富士山"
            value={query}
            maxLength={150}
            onChange={(e) => {
              updateList({ query: e.target.value });
            }}
          />
          <div className="flex flex-wrap gap-3">
            {page !== 'pending' && (
              <label>
                状態{' '}
                <select
                  value={status}
                  onChange={(e) => {
                    updateList({ status: e.target.value });
                  }}
                  className="border border-line p-2"
                >
                  <option value="">すべて</option>
                  {Object.entries(statusLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                  <option value="stopped">使用停止中</option>
                </select>
              </label>
            )}
            <label>
              カテゴリ{' '}
              <select
                value={category}
                disabled={!data}
                onChange={(e) => {
                  updateList({ category: e.target.value });
                }}
                className="border border-line p-2"
              >
                <option value="">
                  {data
                    ? 'すべて'
                    : model.loadFailed
                      ? '取得できませんでした'
                      : 'カテゴリを読み込み中'}
                </option>
                {data?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            1ページの表示件数{' '}
            <select
              className="border border-line p-2"
              value={pageSize}
              onChange={(e) => {
                updateList({ pageSize: Number(e.target.value) });
              }}
            >
              {questionPageSizes.map((size) => (
                <option key={size} value={size}>
                  {size}件
                </option>
              ))}
            </select>
          </label>
          <p role="status">
            {!resultsReady
              ? model.loadFailed
                ? '問題一覧を取得できませんでした。'
                : '問題一覧を読み込んでいます。'
              : `全${total}件${total ? `中 ${(currentPage - 1) * pageSize + 1}〜${Math.min(currentPage * pageSize, total)}件` : ''}`}
          </p>
          <ul
            className="grid gap-3"
            aria-busy={model.busy || (!data && !model.loadFailed)}
          >
            {filtered?.map((row) => (
              <li key={row.id} className="border border-line p-3">
                <a
                  className="font-bold underline"
                  href={href(reviewing ? 'decision' : 'edit', row.id)}
                >
                  {row.input.text || '（未入力）'}
                </a>
                <p>
                  {statusLabels[row.status]}
                  {row.stopped ? '・使用停止中' : ''} ／ {row.input.displayAnswer} ／{' '}
                  {row.input.readings.join('・')}
                </p>
                {reviewing && <p className="text-muted">{row.input.explanation}</p>}
              </li>
            ))}
          </ul>
          <nav
            aria-label="問題一覧のページ移動"
            className="flex flex-wrap items-center gap-3"
          >
            <Button
              disabled={!resultsReady || !!model.error || currentPage <= 1}
              onClick={() => {
                updateList({ page: currentPage - 1 });
              }}
            >
              前へ
            </Button>
            <span>
              {pagination ? `${currentPage} / ${lastPage}ページ` : 'ページ数を確認中'}
            </span>
            <Button
              disabled={!resultsReady || !!model.error || currentPage >= lastPage}
              onClick={() => {
                updateList({ page: currentPage + 1 });
              }}
            >
              次へ
            </Button>
          </nav>
        </section>
      )}
      {(creating || (data && selected && (page === 'edit' || page === 'decision'))) && (
        <section className="grid gap-4 border border-line p-4">
          {creating ||
          (page === 'edit' &&
            selected &&
            selected?.authorId === data?.actorId &&
            selected.status !== 'pending' &&
            selected.status !== 'rejected') ? (
            <QuestionEditor
              key={selected ? `${selected.id}:${selected.revision}` : 'new'}
              row={selected}
              categories={data?.categories ?? []}
              tags={data?.tags ?? []}
              metadataPending={!data}
              metadataFailed={model.loadFailed && !data}
              busy={model.busy || !data}
              save={async (input) => {
                if (!data) return false;
                const ok = await model.mutate({
                  operation: 'save',
                  id: selected?.id,
                  revision: selected?.revision,
                  input,
                });
                if (ok) navigate(returnHref ?? href('mine'));
                return ok;
              }}
            />
          ) : (
            selected && (
              <>
                <h2 className="text-xl font-bold">{selected.input.text}</h2>
                <p>
                  正答：{selected.input.displayAnswer}（
                  {selected.input.readings.join('・')}）
                </p>
                <p>解説：{selected.input.explanation}</p>
                <p className="whitespace-pre-wrap">
                  非公開の根拠：{selected.input.evidence}
                </p>
                <p>出典：{selected.input.source || 'なし'}</p>
                <p>難易度：{['初級', '中級', '上級'][selected.input.difficulty]}</p>
              </>
            )
          )}
          {selected && data && (
            <>
              <p>
                {statusLabels[selected.status]}
                {selected.stopped ? '・使用停止中' : ''} ／ 版 {selected.revision}
              </p>
              {selected.reason && (
                <p className="whitespace-pre-wrap">理由：{selected.reason}</p>
              )}
              <div className="flex flex-wrap gap-3">
                {page === 'edit' && selected.authorId === data.actorId && (
                  <>
                    {['draft', 'returned', 'ended'].includes(selected.status) && (
                      <Button
                        tone="primary"
                        disabled={model.busy || !canSubmit}
                        onClick={() => {
                          void action('submit');
                        }}
                      >
                        {data.settings.mode === 'open'
                          ? '登録・改訂を確定'
                          : '審査へ提出'}
                      </Button>
                    )}
                    {selected.status === 'pending' && (
                      <Button
                        disabled={model.busy}
                        onClick={() => {
                          void action('withdraw');
                        }}
                      >
                        取り下げて編集
                      </Button>
                    )}
                  </>
                )}
                <Button
                  disabled={model.busy}
                  onClick={async () => {
                    try {
                      const result = await questionsRequest<{
                        history: NonNullable<typeof history>;
                      }>(instanceId, { operation: 'history', id: selected.id });
                      setHistory(result.history);
                    } catch (e) {
                      model.setError(e instanceof Error ? e.message : '履歴取得失敗');
                    }
                  }}
                >
                  改訂履歴を確認
                </Button>
              </div>
              {reviewing &&
                (selected.publishedId ||
                  (selected.status === 'pending' &&
                    (data.administrator || selected.authorId !== data.actorId))) && (
                  <>
                    <TextField
                      id="review-reason"
                      label="審査・停止の理由（差戻し・却下・停止／解除は必須）"
                      placeholder="例：正答の根拠を補足してください"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <div className="flex flex-wrap gap-3">
                      {selected.status === 'pending' &&
                        (data.administrator || selected.authorId !== data.actorId) &&
                        (['approve', 'return', 'reject'] as const).map((operation) => (
                          <Button
                            key={operation}
                            disabled={model.busy}
                            onClick={() => {
                              void action(operation);
                            }}
                          >
                            {
                              {
                                approve: '承認',
                                return: '差戻し',
                                reject: '却下',
                              }[operation]
                            }
                          </Button>
                        ))}
                      {selected.publishedId && (
                        <Button
                          disabled={model.busy}
                          onClick={() => {
                            void action(selected.stopped ? 'resume' : 'stop');
                          }}
                        >
                          {selected.stopped ? '使用停止を解除' : '使用停止'}
                        </Button>
                      )}
                    </div>
                  </>
                )}
              {history && (
                <ul>
                  {history.map((event) => (
                    <li key={event.id} className="my-3 border border-line p-3">
                      版 {event.revision}：{event.action}
                      <p>{event.input.text}</p>
                      <p>{event.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
              {page === 'edit' && (
                <a className="underline" href={href('categoryRequest', selected.id)}>
                  カテゴリ変更を申請する
                </a>
              )}
            </>
          )}
        </section>
      )}
      {page === 'categoryRequest' && selected && data && (
        <QuestionCategoryRequest
          data={data}
          row={selected}
          busy={model.busy}
          mutate={model.mutate}
        />
      )}
      {page === 'reports' && data?.review && (
        <QuestionReports
          data={data}
          busy={model.busy}
          mutate={model.mutate}
          instanceId={instanceId}
          selectedId={selectedId}
        />
      )}
      {(
        [
          'classify',
          'classificationJson',
          'difficulty',
          'tags',
          'categoryRequests',
        ] as string[]
      ).includes(page) &&
        data?.review && (
          <QuestionOrganization
            data={data}
            busy={model.busy}
            mutate={model.mutate}
            page={page}
            instanceId={instanceId}
            selectedId={selectedId}
          />
        )}
      {(['qualification', 'authors', 'categories', 'settings'] as string[]).includes(
        page,
      ) &&
        data && (
          <QuestionAdministration
            data={data}
            busy={model.busy}
            mutate={model.mutate}
            page={page}
            instanceId={instanceId}
            selectedId={selectedId}
          />
        )}
      {page === 'selection' && data?.administrator && (
        <QuestionSelectionSettings
          key={data.settingsRevision}
          data={data}
          busy={model.busy}
          mutate={model.mutate}
        />
      )}
    </div>
  );
}
