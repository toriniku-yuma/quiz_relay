import { useCallback, useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { ResultsOverview } from '../../../shared/results';
import { useApp } from '../../app/context';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import { playRequest } from './api';
import PlayReport from './PlayReport';
export default function PlayResults({
  instanceId,
  refreshKey = '',
}: {
  instanceId: string;
  refreshKey?: string;
}) {
  const { guest, organization } = useApp();
  const actor = organization.data?.account?.actorId ?? guest?.data?.id;
  const [data, setData] = useState<ResultsOverview | null>(null),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setData(await playRequest(API_PATHS.playResults, {}, instanceId));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '履歴を読み込めませんでした。');
    }
  }, [instanceId]);
  useEffect(() => {
    if (refreshKey !== undefined) void refresh();
  }, [refresh, refreshKey]);
  return (
    <Panel title="あなたの対戦履歴・振り返り">
      <p className="my-3">
        持込問題の振り返りとゲストの履歴は30日間です。カジュアル・部屋の結果はレートに反映しません。
      </p>
      {error && <p role="alert">{error}</p>}
      <Button onClick={refresh}>履歴を更新</Button>
      <ul className="mt-3 divide-y divide-line">
        {data?.history.map((r) => (
          <li key={r.resultId} className="py-4">
            <p>
              {new Date(r.finishedAt).toLocaleString()} ／{' '}
              {r.kind === 'room' ? '部屋' : r.kind === 'casual' ? 'カジュアル' : 'ランク'}{' '}
              ／{' '}
              {
                {
                  win: '勝利',
                  loss: '敗北',
                  draw: '引き分け',
                  invalid: '無効試合',
                  presenter: '出題専任',
                }[r.outcome]
              }
            </p>
            <p>
              {(
                {
                  exhausted: '問題不足時の正解数で判定',
                  question_limit: '指定問題数終了',
                  last_remaining: '最後の未失格者が勝利',
                  target_reached: '指定正解数に到達',
                  connections: '復帰期限切れ',
                  disqualifications: '未失格者が1人以下',
                  seven_correct: '7問先取',
                } as Record<string, string>
              )[r.reason] ?? r.reason}
            </p>
            <ul>
              {r.players.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span>
                    {p.name}：
                    {p.role === 'presenter'
                      ? '出題専任'
                      : `正解${p.correct}・お手つき${p.mistakes}`}
                    {p.guest ? '（ゲスト）' : ''}
                  </span>
                  {!p.guest && p.id !== actor && (
                    <PlayReport
                      instanceId={instanceId}
                      title={`${p.name}を通報`}
                      input={{ action: 'user', actorId: p.id, resultId: r.resultId }}
                    />
                  )}
                </li>
              ))}
            </ul>
            {r.questions && (
              <details className="mt-3 border border-line p-3">
                <summary>出題済み問題を振り返る（{r.questions.length}問）</summary>
                <ol className="grid gap-4 pt-3">
                  {r.questions.map((q) => (
                    <li key={q.id}>
                      <p>{q.text}</p>
                      <p className="font-bold">
                        {q.displayAnswer}（{q.readings.join('・')}）
                      </p>
                      <p>{q.explanation}</p>
                      {q.source && <p>{q.source}</p>}
                      {q.authorName && <p>作問：{q.authorName}</p>}
                      <PlayReport
                        instanceId={instanceId}
                        title="この問題を通報"
                        input={{
                          action: 'question',
                          questionId: q.id,
                          resultId: r.resultId,
                        }}
                      />
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </li>
        ))}
      </ul>
      {data && !data.history.length && <p>保存済みの対戦はありません。</p>}
    </Panel>
  );
}
