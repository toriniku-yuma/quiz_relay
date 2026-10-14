import { resultKinds, resultReasons } from '../../../shared/results';
import { useApp } from '../../app/context';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import { useForeignHistory } from './useForeignHistory';

export default function ForeignHistoryPanel() {
  const { organization, auth } = useApp(),
    model = useForeignHistory(
      auth.user ? organization.data?.account?.actorId : undefined,
    );
  if (!auth.user) return null;
  return (
    <Panel title="別組織での対戦履歴">
      <p className="my-3">
        レートの増減は開催インスタンスのものです。所属元のレートには加算しません。
      </p>
      <Button disabled={model.busy} onClick={() => model.load()}>
        履歴を再取得
      </Button>
      {model.error && (
        <p className="my-3" role="alert">
          {model.error}
        </p>
      )}
      {model.busy && <p role="status">読み込んでいます。</p>}
      {model.data?.history.length === 0 && (
        <p className="my-3">受信した外部の対戦履歴はありません。</p>
      )}
      <div className="my-5 grid gap-5">
        {model.data?.history.map((entry) => {
          const self = entry.players.find((player) => player.id === entry.selfId),
            outcome = ['connections', 'disqualifications'].includes(entry.reason)
              ? '無効試合'
              : entry.winnerId === null
                ? '引き分け'
                : entry.winnerId === entry.selfId
                  ? '勝利'
                  : '敗北';
          return (
            <article
              key={`${entry.peerOrigin}:${entry.eventId}`}
              className="border border-line p-4"
            >
              <h3 className="font-bold">
                {entry.hostInstanceName} ／ {resultKinds[entry.kind]} ／ {outcome}
              </h3>
              <p>
                {new Date(entry.finishedAt).toLocaleString()} ／{' '}
                {resultReasons[entry.reason] ?? entry.reason}
              </p>
              <p>
                正解 {self?.correct ?? 0} ／ お手つき {self?.mistakes ?? 0} ／ レート{' '}
                {self?.ratingDelta ?? 0}
              </p>
              <p className="break-words text-sm">開催先：{entry.peerOrigin}</p>
              <Button disabled={model.busy} onClick={() => model.showReview(entry)}>
                開催元での振り返りを確認
              </Button>
              {model.review?.eventId === entry.eventId && (
                <div className="mt-4 grid gap-4">
                  {model.review.questions.map((question) => (
                    <details key={question.id}>
                      <summary>{question.text}</summary>
                      <p className="mt-3">
                        正答：{question.displayAnswer} ／ {question.readings.join('・')}
                      </p>
                      <p className="whitespace-pre-wrap">{question.explanation}</p>
                      {question.source && (
                        <p className="break-words">出典：{question.source}</p>
                      )}
                    </details>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {model.data?.nextCursor && (
        <Button
          disabled={model.busy}
          onClick={() => model.load(model.data?.nextCursor ?? undefined)}
        >
          続きを取得
        </Button>
      )}
    </Panel>
  );
}
