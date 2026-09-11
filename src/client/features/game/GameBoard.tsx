import Button from '../../components/Button';
import Panel from '../../components/Panel';
import AnswerPanel from './AnswerPanel';
import type { Game } from './useGame';

const phases = {
  WAITING: '参加者の接続を待っています',
  REVEALING: '早押し受付中',
  ANSWERING: '文字を解答中',
  JUDGED: '判定',
  ENDED: 'この問題は終了しました',
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
      <Panel title="問題">
        <p className="mt-3 text-sm" role="status">
          {phases[state.phase]}
          {holder ? `：${holder.name}` : ''}
        </p>

        <p className="my-6 min-h-32 break-words text-2xl leading-relaxed sm:text-3xl">
          {state.text || '出題を待っています。'}
        </p>

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
            !player ||
            player.locked
          }
          onClick={() => game.send('buzz')}
        >
          早押し
        </Button>

        {player?.locked && state.phase !== 'ENDED' && (
          <p className="mt-3">この問題は再解答できません。</p>
        )}
        <AnswerPanel game={game} />

        {state.phase === 'ENDED' && (
          <p className="mt-5 text-sm">
            1Aは1問ごとの確認です。もう一度遊ぶときはページを再読み込みし、未使用のルーム番号を選んでください。
          </p>
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
              {entry.locked && <span>この問題は解答不可</span>}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
