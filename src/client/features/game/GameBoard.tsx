import Button from '../../components/Button';
import Panel from '../../components/Panel';
import AnswerPanel from './AnswerPanel';
import type { Game } from './useGame';

const phases = {
  WAITING: '参加者の接続を待っています',
  REVEALING: '早押し受付中',
  ANSWERING: '文字を解答中',
  JUDGED: '判定',
  FINISHED: '試合終了',
  INVALID: '無効試合',
};
const judgments = {
  correct: '正解',
  wrong: '誤答',
  timeout: '文字の時間切れ',
  unanswered: '解答なし',
};

export default function GameBoard({ game }: { game: Game }) {
  const state = game.snapshot;
  if (!state) return null;

  const player = state.players.find(({ id }) => id === game.actorId);
  const holder = state.players.find(({ id }) => id === state.holder);
  const judged = state.players.find(({ id }) => id === state.judgment?.actorId);

  return (
    <>
      <Panel title={`第${state.questionNumber}問 / ${state.questionCount}問`}>
        <p className="mt-3 text-sm" role="status">
          {phases[state.phase]}
          {holder ? `：${holder.name}` : ''}
        </p>

        <p className="my-6 min-h-32 break-words text-2xl leading-relaxed sm:text-3xl">
          {state.text || '出題を待っています。'}
        </p>

        <p className="mb-3 text-sm text-muted">
          選択文字の共有：{state.showSelections ? 'オン' : 'オフ'}
        </p>
        {state.roomRules && (
          <p className="mb-3 text-sm">
            {state.roomRules.winMode === 'target'
              ? `${state.roomRules.count}問先取`
              : `${state.roomRules.count}問で競う`}{' '}
            ／{' '}
            {state.roomRules.mistakes === null
              ? '失格なし'
              : `お手つき${state.roomRules.mistakes}回で失格`}
          </p>
        )}
        {state.response && (
          <div className="mb-5 border border-line bg-result p-4" role="status">
            <p className="text-sm">
              {state.players.find(({ id }) => id === state.response?.actorId)?.name}の回答
            </p>
            <p className="mt-2 break-words text-3xl font-bold">
              {state.response.text || '文字を選んでいます'}
            </p>
          </div>
        )}

        {state.reconnect && (
          <p className="mb-5 bg-result p-3 font-bold" role="status">
            切断した参加者の復帰を待っています。残り{' '}
            {Math.max(0, Math.ceil((state.reconnect.deadline - game.clock) / 1000))}秒
            （試合は一時停止中）
          </p>
        )}

        {state.judgment && (
          <p className="mb-5 bg-result p-3 font-bold" role="status">
            {judged ? `${judged.name}：` : ''}
            {judgments[state.judgment.result]}
          </p>
        )}
        {player?.role === 'presenter' ? (
          <Button
            disabled={
              game.connection !== 'open' ||
              game.pending ||
              state.phase !== 'JUDGED' ||
              !!state.reconnect ||
              !!state.result
            }
            onClick={() => game.send('next')}
          >
            次の問題へ
          </Button>
        ) : (
          <Button
            tone="primary"
            className="min-h-20 w-full text-2xl"
            disabled={
              game.connection !== 'open' ||
              game.pending ||
              state.phase !== 'REVEALING' ||
              !!state.reconnect ||
              !player ||
              player.locked
            }
            onClick={() => game.send('buzz')}
          >
            早押し
          </Button>
        )}

        {player?.locked && !state.result && (
          <p className="mt-3">この問題は再解答できません。</p>
        )}
        <AnswerPanel game={game} />

        {state.result && (
          <div className="mt-5 bg-result p-4" role="status">
            <p className="text-xl font-bold">
              {state.phase === 'INVALID'
                ? 'この試合は無効です'
                : state.result.winnerId
                  ? `${state.players.find(({ id }) => id === state.result?.winnerId)?.name}の勝利`
                  : '引き分け'}
            </p>
            <p className="mt-2">
              {
                {
                  target_reached: '規定の正解数に到達',
                  seven_correct: '7問先取で終了しました。',
                  exhausted: '全問終了時の正解数で判定しました。',
                  question_limit: '指定問題数の終了時の正解数で判定しました。',
                  last_remaining: '失格していない最後の1人が勝利しました。',
                  connections:
                    '復帰期限までに接続している参加者が2人以上に戻らなかったため終了しました。',
                  disqualifications: '失格していない参加者が1人以下になりました。',
                }[state.result.reason]
              }
            </p>
            <p className="mt-2 text-sm" role="status">
              {state.result.storage === 'confirmed'
                ? state.kind === 'ranked'
                  ? '確定・レート反映済み'
                  : '確定（レート対象外）'
                : state.result.storage === 'pending'
                  ? state.kind === 'ranked'
                    ? '保存中・レート未反映（自動で再試行します）'
                    : '保存中（自動で再試行します・レート対象外）'
                  : state.result.storage === 'conflict'
                    ? '保存内容の競合・管理者による確認が必要です'
                    : 'DB未保存・ランキング対象外'}
            </p>
            {state.kind === 'ranked' && state.result.ratingChanges && (
              <ul className="mt-2 text-sm">
                {state.result.ratingChanges.map(({ actorId, delta }) => (
                  <li key={actorId}>
                    {state.players.find((entry) => entry.id === actorId)?.name}：レート{' '}
                    {delta > 0 ? '+' : ''}
                    {delta}
                    {state.result?.storage !== 'confirmed' && '（保存待ち）'}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Panel>

      {state.revealedAnswer && (
        <Panel title="正答と解説">
          <p className="mt-3 font-bold">
            {state.revealedAnswer.displayAnswer}（
            {state.revealedAnswer.readings.join('・')}）
          </p>
          <p>{state.revealedAnswer.explanation}</p>
          <p className="break-words">{state.revealedAnswer.source}</p>
          {state.revealedAnswer.authorName && (
            <p>作問：{state.revealedAnswer.authorName}</p>
          )}
        </Panel>
      )}
      <Panel title="参加者">
        <p className="mt-3 text-sm">
          回答者 {state.players.filter((p) => p.role !== 'presenter').length} /{' '}
          {state.playersRequired} 人
        </p>
        <ul className="mt-4 divide-y divide-line">
          {state.players.map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-x-5 gap-y-2 py-3">
              <span className="font-bold">
                {entry.name}
                {entry.id === game.actorId ? '（あなた）' : ''}
              </span>
              {entry.role === 'presenter' ? (
                <span>出題専任</span>
              ) : (
                <>
                  <span>正解 {entry.correct}</span>
                  <span>お手つき {entry.mistakes}</span>
                </>
              )}
              {entry.guest && <span>ゲスト</span>}
              {entry.disqualified ? (
                <span>失格</span>
              ) : (
                entry.locked && <span>この問題は解答不可</span>
              )}
              {!entry.connected && <span>切断中</span>}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
