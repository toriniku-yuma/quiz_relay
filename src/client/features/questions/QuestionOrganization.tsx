import { useState } from 'react';
import type { QuestionOverview } from '../../../shared/questions';
import Button from '../../components/Button';
import TextField from '../../components/TextField';
import { type QuestionPage, questionHref } from './pages';
import { type QuestionSort, questionSortOptions, sortQuestions } from './sort';

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
  const [selected, setSelected] = useState<string[]>([]);
  const [category, setCategory] = useState('');
  const [level, setLevel] = useState(0);
  const [fixed, setFixed] = useState(false);
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [json, setJson] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<
    { id: string; revision: number; categoryId: string }[]
  >([]);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<QuestionSort>('rate-asc');
  const [players, setPlayers] = useState(2);
  const [band, setBand] = useState(0);
  const statsFor = (series: string) =>
    data.difficulty
      .find((item) => item.seriesId === series)
      ?.stats.filter((item) => item.players === players && item.band === band) ?? [];
  const rate = (series: string) => {
    const stats = statsFor(series);
    const trials = stats.reduce((sum, item) => sum + item.trials, 0);
    return trials ? stats.reduce((sum, item) => sum + item.correct, 0) / trials : null;
  };
  const rows = sortQuestions(
    data.submissions.filter(
      (row) =>
        !filter ||
        String(
          data.difficulty.find((item) => item.seriesId === row.seriesId)?.current ??
            row.input.difficulty,
        ) === filter,
    ),
    data.difficulty,
    players,
    band,
    sort,
  );
  function prepare() {
    try {
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 500)
        throw new Error('1〜500件の配列で指定してください。');
      const seen = new Set<string>();
      const next = parsed.map((item: { id?: string; categoryId?: string }) => {
        const row = data.submissions.find((row) => row.id === item.id);
        if (
          !row ||
          seen.has(row.id) ||
          !data.categories.some(
            (category) => category.active && category.id === item.categoryId,
          )
        )
          throw new Error('不明・重複した問題IDまたは無効なカテゴリIDがあります。');
        seen.add(row.id);
        return {
          id: row.id,
          revision: row.revision,
          categoryId: item.categoryId as string,
        };
      });
      setPreview(next);
      setError('');
    } catch (error) {
      setPreview([]);
      setError(error instanceof Error ? error.message : 'JSONを確認してください。');
    }
  }
  return (
    <section className="grid gap-3 border border-line p-4">
      <div className="mt-4 grid gap-3">
        {page === 'difficulty' && (
          <label>
            集計の実力帯
            <select
              className="m-2 border border-line p-2"
              value={band}
              onChange={(event) => setBand(Number(event.target.value))}
            >
              {['初級', '中級', '上級'].map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
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
        {['difficulty', 'classify', 'classificationJson'].includes(page) && (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className="flex items-center gap-2">
                難易度で絞り込み
                <select
                  className="border border-line p-2"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                >
                  <option value="">すべて</option>
                  {['初級', '中級', '上級'].map((name, index) => (
                    <option key={name} value={index}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                集計の対戦人数
                <select
                  className="border border-line p-2"
                  value={players}
                  onChange={(event) => setPlayers(Number(event.target.value))}
                >
                  {[2, 3, 4].map((count) => (
                    <option key={count}>{count}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                並び順
                <select
                  className="border border-line p-2"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as QuestionSort)}
                >
                  {Object.entries(questionSortOptions).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {rows.map((row) => {
              const difficulty = data.difficulty.find(
                (item) => item.seriesId === row.seriesId,
              );
              const stats = statsFor(row.seriesId);
              const trials = stats.reduce((sum, item) => sum + item.trials, 0);
              return (
                <label key={row.id} className="border border-line p-3">
                  <input
                    type="checkbox"
                    checked={selected.includes(row.id)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, row.id]
                          : selected.filter((id) => id !== row.id),
                      )
                    }
                  />{' '}
                  {row.input.text || '未入力'}
                  <span className="block text-sm">
                    {
                      ['初級', '中級', '上級'][
                        difficulty?.current ?? row.input.difficulty
                      ]
                    }{' '}
                    /{' '}
                    {trials
                      ? `${Math.round((rate(row.seriesId) ?? 0) * 100)}%・${trials}回`
                      : '未出題'}{' '}
                    {difficulty?.fixed ? '固定中' : ''} {difficulty?.reason}
                  </span>
                </label>
              );
            })}
          </>
        )}
        {page === 'classify' && (
          <>
            <label>
              移動先カテゴリ
              <select
                className="m-2 border border-line p-2"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">選択してください</option>
                {data.categories
                  .filter((item) => item.active)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              disabled={busy || !selected.length || !category}
              onClick={() => {
                void mutate({
                  operation: 'classify',
                  changes: data.submissions
                    .filter((row) => selected.includes(row.id))
                    .map((row) => ({
                      id: row.id,
                      revision: row.revision,
                      categoryId: category,
                    })),
                });
              }}
            >
              選択した問題のカテゴリを変更
            </Button>
          </>
        )}
        {page === 'difficulty' && data.administrator && (
          <>
            <label>
              変更後の難易度
              <select
                className="m-2 border border-line p-2"
                value={level}
                onChange={(event) => setLevel(Number(event.target.value))}
              >
                {['初級', '中級', '上級'].map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={fixed}
                onChange={(event) => setFixed(event.target.checked)}
              />{' '}
              自動更新せず固定する
            </label>
            <TextField
              id="difficulty-reason"
              label="難易度変更の理由"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <Button
              disabled={busy || !selected.length || !reason.trim()}
              onClick={() => {
                void mutate({
                  operation: 'difficulty',
                  reason,
                  changes: data.submissions
                    .filter((row) => selected.includes(row.id))
                    .map((row) => ({
                      id: row.id,
                      revision: row.revision,
                      difficulty: level,
                      fixed,
                    })),
                });
              }}
            >
              難易度・固定設定を変更
            </Button>
          </>
        )}
        {page === 'classificationJson' && (
          <>
            <Button
              disabled={!selected.length}
              onClick={() => {
                setJson(
                  JSON.stringify(
                    {
                      questions: data.submissions
                        .filter((row) => selected.includes(row.id))
                        .map((row) => ({
                          id: row.id,
                          text: row.input.text,
                          displayAnswer: row.input.displayAnswer,
                          categoryId: row.input.categoryId,
                        })),
                      categories: data.categories
                        .filter((item) => item.active)
                        .map(({ id, name }) => ({ id, name })),
                    },
                    null,
                    2,
                  ),
                );
                setPreview([]);
              }}
            >
              選択問題の分類用JSONを表示
            </Button>
            <label className="grid gap-2">
              分類用JSON／読み込む分類結果
              <textarea
                className="min-h-40 border border-line p-3"
                value={json}
                onChange={(event) => {
                  setJson(event.target.value);
                  setPreview([]);
                }}
                placeholder={'[{"id":"問題ID","categoryId":"移動先ID"}]'}
              />
            </label>
            <Button onClick={prepare}>分類結果を読み込んで変更前後を確認</Button>
            {error && <p role="alert">{error}</p>}
            {preview.map((change) => {
              const row = data.submissions.find((row) => row.id === change.id);
              return (
                <p key={change.id}>
                  {row?.input.text}：
                  {
                    data.categories.find((item) => item.id === row?.input.categoryId)
                      ?.name
                  }{' '}
                  → {data.categories.find((item) => item.id === change.categoryId)?.name}
                </p>
              );
            })}
            {!!preview.length && (
              <Button
                disabled={busy}
                onClick={async () => {
                  if (await mutate({ operation: 'classify', changes: preview }))
                    setPreview([]);
                }}
              >
                確認したカテゴリ変更を一括反映
              </Button>
            )}
          </>
        )}
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
