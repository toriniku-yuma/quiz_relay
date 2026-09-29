import { useApp } from '../../app/context';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import ReasonAction from '../moderation/ReasonAction';
import QuestionReview from './QuestionReview';
import { useResults } from './useResults';

export default function ResultsPanel({
  refreshKey,
  instanceId = '',
}: {
  refreshKey: string;
  instanceId?: string;
}) {
  const { organization } = useApp();
  const results = useResults(refreshKey, instanceId);
  return (
    <Panel title="このインスタンスのランキング・対戦履歴">
      <p className="my-3 text-sm">
        初期レート1000。ランクマッチの確定結果を集計します。カジュアル・部屋建ては対象外です。
      </p>
      {results.error && (
        <Button disabled={results.busy} onClick={results.refresh}>
          再試行
        </Button>
      )}
      {results.error && (
        <p className="my-3" role="alert">
          {results.error}
        </p>
      )}
      <h3 className="mt-5 font-bold">ランキング（上位100人）</h3>
      {!results.data && (
        <p role="status">
          {results.error
            ? 'ランキングを取得できませんでした。'
            : 'ランキングを読み込んでいます。'}
        </p>
      )}
      <ol className="mt-2 divide-y divide-line">
        {results.data?.ranking.map((entry) => (
          <li key={entry.actorId} className="flex gap-4 py-2">
            <span>{entry.rank}位</span>
            <span>{entry.name}</span>
            <span>{entry.rating}</span>
          </li>
        ))}
      </ol>
      {results.data && !results.data.ranking.length && (
        <p className="mt-2">保存済みのランクマッチはありません。</p>
      )}
      <h3 className="mt-5 font-bold">あなたの履歴（最新20試合）</h3>
      {!results.data && (
        <p role="status">
          {results.error
            ? '対戦履歴を取得できませんでした。'
            : '対戦履歴を読み込んでいます。'}
        </p>
      )}
      <ul className="mt-2 divide-y divide-line">
        {results.data?.history.map((entry) => (
          <li key={entry.resultId} className="py-2">
            {new Date(entry.finishedAt).toLocaleString()}：
            {
              { win: '勝利', loss: '敗北', draw: '引き分け', invalid: '無効試合' }[
                entry.outcome
              ]
            }
            ／ レート {entry.ratingDelta > 0 ? '+' : ''}
            {entry.ratingDelta}（確定）
            <ul className="mt-1 text-sm">
              {entry.players.map((player) => (
                <li key={player.id} className="flex items-center gap-2">
                  <span>
                    {player.name}：正解{player.correct}・お手つき{player.mistakes}
                  </span>
                  {instanceId && player.id !== organization.data?.account?.actorId && (
                    <ReasonAction
                      report
                      title={`${player.name}を通報`}
                      input={{
                        action: 'report',
                        instanceId,
                        actorId: player.id,
                        resultId: entry.resultId,
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
            {entry.questions && (
              <QuestionReview
                questions={entry.questions}
                resultId={entry.resultId}
                instanceId={instanceId}
              />
            )}
          </li>
        ))}
      </ul>
      {results.data && !results.data.history.length && (
        <p className="mt-2">保存済みの対戦はありません。</p>
      )}
    </Panel>
  );
}
