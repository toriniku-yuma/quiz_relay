import Button from '../components/Button';
import PageHeader from '../components/PageHeader';
import GameBoard from '../features/game/GameBoard';
import JoinGame from '../features/game/JoinGame';
import { useGame } from '../features/game/useGame';

const connections = {
  idle: '未接続',
  connecting: '接続中',
  open: '接続済み',
  closed: '切断・再接続中（操作できません）',
  stopped: '自動再接続を停止しました',
};

export default function GamePage() {
  const game = useGame();

  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-10 sm:px-8 sm:pt-10 sm:pb-16">
      <PageHeader
        title="早押しクイズ"
        description="ローカル専用の試合確認画面です。問題はDB、検証用ルールは設定ファイルを使います。"
      />
      <p className="text-sm" role="status">
        {connections[game.connection]}
      </p>
      {game.error && (
        <p className="mt-4 border border-accent p-3" role="alert">
          {game.error}
        </p>
      )}

      {game.connection === 'stopped' && (
        <Button className="mt-4" onClick={game.reconnect}>
          再接続
        </Button>
      )}

      {game.snapshot ? <GameBoard game={game} /> : <JoinGame game={game} />}
      {game.snapshot && (
        <Button className="mt-5" onClick={game.leave}>
          退出して別のルームへ
        </Button>
      )}
      <p className="mt-6 text-sm text-muted">
        対戦結果はローカルに保持されます。正式な結果のDB保存とランキング反映は1Dで実装します。
      </p>
    </main>
  );
}
