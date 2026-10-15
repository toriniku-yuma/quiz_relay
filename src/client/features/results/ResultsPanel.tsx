import {
  type ResultsQuery,
  resultKinds,
  resultOutcomes,
  resultReasons,
} from '../../../shared/results';
import { useApp } from '../../app/context';
import { navigate } from '../../app/navigation';
import { HISTORY_PATH } from '../../app/paths';
import Button from '../../components/Button';
import DataTable from '../../components/DataTable';
import Panel from '../../components/Panel';
import PlayReport from '../rooms/PlayReport';
import SelfRanking from './SelfRanking';
import { useResults } from './useResults';

export default function ResultsPanel({
  section = 'history',
  instanceId = '',
  matchId = '',
}: {
  section?: 'history' | 'ranking';
  instanceId?: string;
  matchId?: string;
}) {
  const { auth, organization, guest, url } = useApp();
  const kind = url.searchParams.get('kind') ?? '';
  const query: ResultsQuery = matchId
    ? { section: 'history', matchId }
    : {
        section,
        ...(section === 'history' && ['ranked', 'casual', 'room'].includes(kind)
          ? { kind: kind as ResultsQuery['kind'] }
          : {}),
      };
  const results = useResults(
    auth.user?.id ?? guest?.data?.id ?? '',
    instanceId,
    query,
    !auth.user,
  );
  const actor = organization.data?.account?.actorId ?? guest?.data?.id;
  const params = new URLSearchParams({ instance: instanceId });
  if (!auth.user) params.set('guest', '1');
  if (kind) params.set('kind', kind);
  const historyHref = `${HISTORY_PATH}?${params}`;
  const entry = results.data?.history[0];
  return (
    <Panel
      title={
        section === 'ranking'
          ? 'ランキング（上位100人）'
          : matchId
            ? '試合の詳細'
            : '対戦履歴'
      }
    >
      <div className="my-4 flex flex-wrap items-center gap-4">
        {matchId ? (
          <a className="underline" href={historyHref}>
            対戦履歴へ戻る
          </a>
        ) : section === 'history' ? (
          <label>
            種別{' '}
            <select
              className="ml-3 border border-line bg-paper p-3"
              value={kind}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                if (event.target.value) next.set('kind', event.target.value);
                else next.delete('kind');
                navigate(`${HISTORY_PATH}?${next}`);
              }}
            >
              <option value="">すべて</option>
              <option value="ranked">ランク</option>
              <option value="casual">カジュアルマッチ</option>
              <option value="room">部屋</option>
            </select>
          </label>
        ) : null}
        <Button
          disabled={results.busy}
          onClick={results.error ? results.retry : results.refresh}
        >
          {results.error ? '再試行' : '更新'}
        </Button>
      </div>
      {results.error && (
        <p role="alert" className="my-3">
          {results.error}
        </p>
      )}
      {results.busy && (
        <p role="status" className="my-3">
          読み込み中
        </p>
      )}
      {section === 'ranking' ? (
        <>
          <p className="my-3">初期レート1000。ランクマッチの確定結果を集計します。</p>
          <SelfRanking value={results.data?.self} />
          <DataTable
            label="ランキング"
            columns={['順位', '名前', 'レート']}
            busy={results.busy}
          >
            {results.data?.ranking.map((player) => (
              <tr key={player.actorId}>
                <td>{player.rank}位</td>
                <td>{player.name}</td>
                <td>{player.rating}</td>
              </tr>
            ))}
          </DataTable>
          {results.data && !results.data.ranking.length && (
            <p className="mt-3">保存済みのランクマッチはありません。</p>
          )}
        </>
      ) : matchId ? (
        entry && (
          <>
            <p className="my-3">
              {new Date(entry.finishedAt).toLocaleString()} ／{' '}
              {resultKinds[entry.kind ?? 'ranked']} ／ {resultOutcomes[entry.outcome]}
            </p>
            <p className="my-3">
              {resultReasons[entry.reason] ?? entry.reason} ／{' '}
              {entry.kind === 'ranked'
                ? `レート ${entry.ratingDelta > 0 ? '+' : ''}${entry.ratingDelta}`
                : 'レート変動なし'}
            </p>
            <DataTable
              label="試合の参加者"
              columns={['名前', '正解数', 'お手つき', 'レート差分', '通報']}
            >
              {entry.players.map((player) => (
                <tr key={player.id}>
                  <td>
                    {player.name}
                    {player.guest ? '（ゲスト）' : ''}
                    {player.role === 'presenter' ? '（出題専任）' : ''}
                  </td>
                  <td>{player.correct}</td>
                  <td>{player.mistakes}</td>
                  <td>{entry.kind === 'ranked' ? player.ratingDelta : '—'}</td>
                  <td>
                    {instanceId && actor && !player.guest && player.id !== actor && (
                      <PlayReport
                        instanceId={instanceId}
                        title={`${player.name}を通報`}
                        input={{
                          action: 'user',
                          actorId: player.id,
                          matchId: entry.matchId,
                        }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
            {entry.questions && (
              <details className="mt-4 border border-line p-3">
                <summary>出題済み問題を振り返る（{entry.questions.length}問）</summary>
                <ol className="grid gap-4 pt-3">
                  {entry.questions.map((question) => (
                    <li key={question.id} className="grid gap-2 border border-line p-3">
                      <p>{question.text}</p>
                      <p className="font-bold">
                        {question.displayAnswer}（{question.readings.join('・')}）
                      </p>
                      <p>{question.explanation}</p>
                      {question.source && (
                        <p className="break-words">{question.source}</p>
                      )}
                      {question.authorName && <p>作問：{question.authorName}</p>}
                      {instanceId && (
                        <PlayReport
                          instanceId={instanceId}
                          title="この問題を通報"
                          input={{
                            action: 'question',
                            questionId: question.id,
                            matchId: entry.matchId,
                          }}
                        />
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </>
        )
      ) : (
        <>
          <p className="my-3">
            最新20試合から表示します。持込問題の振り返りとゲストの履歴は30日間です。
          </p>
          <DataTable
            label="対戦履歴"
            columns={[
              '終了日時',
              '種別',
              '勝敗',
              '正解数',
              'お手つき',
              'レート差分',
              '詳細',
            ]}
            busy={results.busy}
          >
            {results.data?.history.map((match) => (
              <tr key={match.matchId}>
                <td>{new Date(match.finishedAt).toLocaleString()}</td>
                <td>{resultKinds[match.kind ?? 'ranked']}</td>
                <td>{resultOutcomes[match.outcome]}</td>
                <td>{match.correct ?? 0}</td>
                <td>{match.mistakes ?? 0}</td>
                <td>
                  {match.kind === 'ranked'
                    ? `${match.ratingDelta > 0 ? '+' : ''}${match.ratingDelta}`
                    : '—'}
                </td>
                <td>
                  <a
                    className="underline"
                    href={`${historyHref}&result=${match.matchId}`}
                  >
                    詳細
                  </a>
                </td>
              </tr>
            ))}
          </DataTable>
          {results.data?.nextCursor && (
            <Button className="mt-4" disabled={results.busy} onClick={results.loadMore}>
              さらに20件表示
            </Button>
          )}
        </>
      )}
      {results.data && !results.data.history.length && section === 'history' && (
        <p className="mt-3">
          {matchId
            ? 'この試合の詳細を表示できません。保存中の場合は更新してください。'
            : '保存済みの対戦はありません。'}
        </p>
      )}
    </Panel>
  );
}
