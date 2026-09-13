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
                  seven_correct: '7問先取で終了しました。',
                  exhausted: '全問終了時の正解数で判定しました。',
                  connections:
                    '30秒以内に接続している参加者が2人以上に戻らなかったため終了しました。',
                  disqualifications: '失格していない参加者が1人以下になりました。',
                }[state.result.reason]
              }
            </p>
            <p className="mt-2 text-sm">DB未保存・ランキング対象外（ローカル検証）</p>
          </div>
        )}
      </Panel>

      <Panel title="参加者">
        <p className="mt-3 text-sm">
          参加登録 {state.players.length} / {state.playersRequired} 人
        </p>
        <ul className="mt-4 divide-y divide-line">
          {state.players.map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-x-5 gap-y-2 py-3">
              <span className="font-bold">
                {entry.name}
                {entry.id === game.actorId ? '（あなた）' : ''}
              </span>
              <span>正解 {entry.correct}</span>
              <span>お手つき {entry.mistakes}</span>
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
