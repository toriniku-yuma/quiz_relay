import { useState } from 'react';
import { exportQuestionJson } from '../../../shared/question-json';
import {
  canSubmitQuestion,
  type Submission,
  statusLabels,
  validateQuestionInput,
} from '../../../shared/questions';
import { navigate } from '../../app/navigation';
import Button from '../../components/Button';
import Checkbox from '../../components/Checkbox';
import DataTable from '../../components/DataTable';
import IconButton from '../../components/IconButton';
import Pagination from '../../components/Pagination';
import TextField from '../../components/TextField';
import { useTableSelection } from '../../components/useTableSelection';
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
import QuestionActions from './QuestionActions';
import QuestionAdministration from './QuestionAdministration';
import QuestionCategoryRequest from './QuestionCategoryRequest';
import QuestionClassification from './QuestionClassification';
import QuestionEditor from './QuestionEditor';
import QuestionExport from './QuestionExport';
import QuestionImport from './QuestionImport';
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
  const {
    query,
    status,
    category,
    page: listPage,
    pageSize,
    sort,
    direction,
    band,
    players,
    shared,
    sourceInstanceId,
    peerOrigin,
    sourceCategory,
  } = listState;
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
        sort,
        direction,
        band,
        players,
        shared,
        sourceInstanceId,
        peerOrigin,
        sourceCategory,
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
          band,
          players,
          scope: page === 'mine' ? 'mine' : page === 'pending' ? 'pending' : 'all',
          page: listPage,
          pageSize,
          query,
          status,
          category,
          sort,
          direction,
          shared,
          sourceInstanceId,
          peerOrigin,
          sourceCategory,
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
  const selection = useTableSelection<Submission>(
    JSON.stringify([
      instanceId,
      data?.actorId,
      page,
      query,
      status,
      category,
      band,
      players,
      shared,
      sourceInstanceId,
      peerOrigin,
      sourceCategory,
    ]),
  );
  const [actionRows, setActionRows] = useState<Submission[]>([]),
    [actionsOpen, setActionsOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [classificationOpen, setClassificationOpen] = useState(false);
  const resultsReady =
    !!data && !model.stale && (model.retaining || (!model.busy && !model.loadFailed));
  const pagination = resultsReady ? data?.pagination : undefined;
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
  const visible = filtered ?? [];
  const allSelected =
    visible.length > 0 &&
    visible.every((submission) =>
      selection.rows.some((selectedRow) => selectedRow.id === submission.id),
    );
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
              } catch (error) {
                model.setError(
                  error instanceof Error ? error.message : '出力できませんでした。',
                );
              }
            }}
          >
            自作問題をJSON出力
          </Button>
        </div>
      )}
      {page === 'import' && data && (
        <QuestionImport
          instanceId={instanceId}
          data={data}
          canSubmit={!!canSubmit}
          saved={model.refresh}
        />
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
            onChange={(event) => {
              updateList({ query: event.target.value });
            }}
          />
          <div className="flex flex-wrap gap-3">
            {page === 'review' && (
              <>
                <label>
                  問題の種類{' '}
                  <select
                    className="border border-line p-2"
                    value={shared}
                    onChange={(event) =>
                      updateList({
                        shared: event.target.value as typeof shared,
                        ...(event.target.value === 'local'
                          ? { sourceInstanceId: '', peerOrigin: '', sourceCategory: '' }
                          : {}),
                      })
                    }
                  >
                    <option value="all">すべて</option>
                    <option value="local">このインスタンスの問題</option>
                    <option value="shared">共有問題</option>
                    <option value="excluded">除外した共有問題</option>
                  </select>
                </label>
                <label>
                  共有元{' '}
                  <select
                    className="border border-line p-2"
                    value={sourceInstanceId ? `${peerOrigin}|${sourceInstanceId}` : ''}
                    onChange={(event) => {
                      const [origin, id] = event.target.value.split('|');
                      updateList({
                        sourceInstanceId: id ?? '',
                        peerOrigin: origin ?? '',
                        sourceCategory: '',
                        shared: 'shared',
                      });
                    }}
                  >
                    <option value="">すべて</option>
                    {data?.sharedSources?.map((source) => (
                      <option
                        key={`${source.peerOrigin}|${source.instanceId}`}
                        value={`${source.peerOrigin}|${source.instanceId}`}
                      >
                        {source.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  共有元のカテゴリ{' '}
                  <select
                    className="border border-line p-2"
                    value={
                      sourceCategory
                        ? `${peerOrigin}|${sourceInstanceId}|${sourceCategory}`
                        : ''
                    }
                    onChange={(event) => {
                      const [origin, id, categoryId] = event.target.value.split('|');
                      updateList({
                        sourceCategory: categoryId ?? '',
                        ...(categoryId
                          ? { peerOrigin: origin, sourceInstanceId: id, shared: 'shared' }
                          : {}),
                      });
                    }}
                  >
                    <option value="">すべて</option>
                    {data?.sharedSourceCategories
                      ?.filter(
                        (category) =>
                          !sourceInstanceId ||
                          (category.instanceId === sourceInstanceId &&
                            category.peerOrigin === peerOrigin),
                      )
                      .map((category) => (
                        <option
                          key={`${category.peerOrigin}|${category.instanceId}|${category.id}`}
                          value={`${category.peerOrigin}|${category.instanceId}|${category.id}`}
                        >
                          {category.name}（
                          {
                            data.sharedSources?.find(
                              (source) =>
                                source.peerOrigin === category.peerOrigin &&
                                source.instanceId === category.instanceId,
                            )?.name
                          }
                          ）
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
            {page !== 'pending' && (
              <label>
                状態{' '}
                <select
                  value={status}
                  onChange={(event) => {
                    updateList({ status: event.target.value });
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
                  <option value="deleted">削除済み</option>
                </select>
              </label>
            )}
            <label>
              カテゴリ{' '}
              <select
                value={category}
                disabled={!data}
                onChange={(event) => {
                  updateList({ category: event.target.value });
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
                {data?.categories.map((availableCategory) => (
                  <option key={availableCategory.id} value={availableCategory.id}>
                    {availableCategory.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!resultsReady && (
            <p role="status">
              {model.loadFailed
                ? '問題一覧を取得できませんでした。'
                : '問題一覧を読み込んでいます。'}
            </p>
          )}
          {reviewing && data && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <label>
                  実力帯
                  <select
                    className="m-2 border border-line p-2"
                    value={band}
                    onChange={(event) =>
                      updateList({
                        band:
                          event.target.value === 'all'
                            ? 'all'
                            : Number(event.target.value),
                      })
                    }
                  >
                    <option value="all">すべて</option>
                    {['初級帯', '中級帯', '上級帯'].map((label, i) => (
                      <option key={label} value={i}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  対戦人数
                  <select
                    className="m-2 border border-line p-2"
                    value={players}
                    onChange={(event) =>
                      updateList({
                        players:
                          event.target.value === 'all'
                            ? 'all'
                            : Number(event.target.value),
                      })
                    }
                  >
                    <option value="all">すべて</option>
                    {[2, 3, 4].map((playerCount) => (
                      <option key={playerCount} value={playerCount}>
                        {playerCount}人
                      </option>
                    ))}
                  </select>
                </label>
                <span>選択中 {selection.rows.length}件</span>
                <Button
                  disabled={!selection.rows.length}
                  onClick={() => {
                    setActionRows(selection.rows);
                    setActionsOpen(true);
                  }}
                >
                  一括操作
                </Button>
                <Button disabled={!selection.rows.length} onClick={selection.clear}>
                  選択解除
                </Button>
                <Button onClick={() => setExportOpen(true)}>問題エクスポート</Button>
                <Button
                  disabled={!selection.rows.length}
                  onClick={() => setClassificationOpen(true)}
                >
                  分類用JSON
                </Button>
              </div>
              <QuestionActions
                rows={actionRows}
                data={data}
                instanceId={instanceId}
                open={actionsOpen}
                onClose={() => setActionsOpen(false)}
                saved={async () => {
                  await model.refresh();
                  selection.clear();
                }}
              />
              {exportOpen && (
                <QuestionExport
                  instanceId={instanceId}
                  ids={selection.rows.map((selectedRow) => selectedRow.id)}
                  onClose={() => setExportOpen(false)}
                />
              )}
              <QuestionClassification
                open={classificationOpen}
                onClose={() => setClassificationOpen(false)}
                data={{ ...data, submissions: selection.rows }}
                instanceId={instanceId}
                saved={model.refresh}
              />
            </>
          )}
          <DataTable
            selection={
              reviewing ? (
                <Checkbox
                  aria-label="このページの問題をすべて選択"
                  checked={allSelected}
                  mixed={
                    !allSelected &&
                    visible.some((submission) =>
                      selection.rows.some(
                        (selectedRow) => selectedRow.id === submission.id,
                      ),
                    )
                  }
                  onChange={(event) => selection.select(visible, event.target.checked)}
                />
              ) : undefined
            }
            label="問題一覧"
            sorting={model.retaining ? model.displaySorting : { sort, direction }}
            busy={model.busy}
            onSort={updateList}
            columns={[
              { label: '問題文', key: 'text' },
              { label: '正答・読み', key: 'answer' },
              { label: '状態', key: 'status' },
              { label: 'カテゴリ', key: 'category' },
              { label: '作問者', key: 'author' },
              { label: '更新日時', key: 'updatedAt', initial: 'desc' },
              ...(reviewing
                ? [
                    { label: '難易度', key: 'difficulty', initial: 'desc' as const },
                    { label: '更新方式', key: 'fixed', initial: 'desc' as const },
                    { label: '正答率', key: 'rate', initial: 'desc' as const },
                    { label: '出題回数', key: 'trials', initial: 'desc' as const },
                    { label: '未対応通報', key: 'reports', initial: 'desc' as const },
                    { label: '再審議', key: 'review', initial: 'desc' as const },
                    '操作',
                  ]
                : []),
            ]}
          >
            {filtered?.map((row) => (
              <tr key={row.id}>
                {reviewing && (
                  <td>
                    <Checkbox
                      aria-label={`${row.input.text || '未入力'}を選択`}
                      checked={selection.rows.some(
                        (selectedRow) => selectedRow.id === row.id,
                      )}
                      onChange={(event) => selection.select([row], event.target.checked)}
                    />
                  </td>
                )}
                <td className="max-w-sm whitespace-normal">
                  <a
                    className="font-bold underline"
                    href={href(reviewing ? 'decision' : 'edit', row.id)}
                  >
                    {row.input.text || '（未入力）'}
                  </a>
                </td>
                <td>
                  {row.input.displayAnswer}
                  <br />
                  {row.input.readings.join('・')}
                </td>
                <td>
                  {statusLabels[row.status]}
                  {row.shared?.excluded ? '・出題から除外' : ''}
                  {row.deletedAt
                    ? '・削除済み'
                    : row.stopped || row.reviewHold
                      ? '・使用停止中'
                      : ''}
                </td>
                <td>
                  {data?.categories.find(
                    (availableCategory) => availableCategory.id === row.input.categoryId,
                  )?.name ?? '未設定'}
                  {row.shared && (
                    <p className="text-xs">
                      共有元カテゴリ：{row.shared.sourceCategory?.name}
                    </p>
                  )}
                </td>
                <td>
                  {row.provenance?.author ??
                    data?.authorNames?.[row.authorId] ??
                    '表示名未登録'}
                  {row.provenance && (
                    <p className="text-xs">出力元：{row.provenance.instance}</p>
                  )}
                </td>
                <td>{new Date(row.updatedAt).toLocaleString()}</td>
                {reviewing && (
                  <>
                    <td>
                      {
                        ['簡単', '普通', '難しい'][
                          row.metrics?.difficulty ?? row.input.difficulty
                        ]
                      }
                    </td>
                    <td>{row.metrics?.fixed ? '固定' : '自動'}</td>
                    <td>
                      {row.metrics?.rate == null
                        ? '—'
                        : `${(row.metrics.rate * 100).toFixed(1)}%`}
                    </td>
                    <td>{row.metrics?.trials ?? 0}</td>
                    <td>{row.metrics?.reports ?? 0}</td>
                    <td>{row.metrics?.review ? '対象' : '—'}</td>
                    <td>
                      <IconButton
                        icon="wrench"
                        label={`問題「${row.input.text}」の操作`}
                        onClick={() => {
                          setActionRows([row]);
                          setActionsOpen(true);
                        }}
                      />
                    </td>
                  </>
                )}
              </tr>
            ))}
          </DataTable>
          <Pagination
            value={pagination}
            pageSize={pageSize}
            disabled={model.busy || !resultsReady || !!model.error}
            onChange={updateList}
          />
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
                <p>難易度：{['簡単', '普通', '難しい'][selected.input.difficulty]}</p>
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
                    } catch (error) {
                      model.setError(
                        error instanceof Error ? error.message : '履歴取得失敗',
                      );
                    }
                  }}
                >
                  改訂履歴を確認
                </Button>
              </div>
              {selected.shared && (
                <p>
                  共有問題です。本文・カテゴリの改訂は共有元で行います。
                  {selected.shared.expired
                    ? '保存期限を過ぎたため、内容を再取得するまで利用できません。'
                    : '除外・解除は「全問題」の問題操作で設定できます。'}
                </p>
              )}
              {reviewing &&
                !selected.shared &&
                (selected.publishedId ||
                  (selected.status === 'pending' &&
                    (data.administrator || selected.authorId !== data.actorId))) && (
                  <>
                    <TextField
                      id="review-reason"
                      label="審査・停止の理由（差戻し・却下・停止／解除は必須）"
                      placeholder="例：正答の根拠を補足してください"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
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
              {page === 'edit' && !selected.shared && (
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
      {(['tags', 'categoryRequests'] as string[]).includes(page) && data?.review && (
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
