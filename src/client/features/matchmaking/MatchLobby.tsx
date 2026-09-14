import { useState } from 'react';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import type { Auth } from '../auth/useAuth';
import GameBoard from '../game/GameBoard';
import { useMatchmaking } from './useMatchmaking';

export default function MatchLobby({ auth }: { auth: Auth }) {
  const match = useMatchmaking(auth.user?.id ?? '');
  const [name, setName] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const game = match.game;
  const finished =
    game.snapshot?.phase === 'FINISHED' || game.snapshot?.phase === 'INVALID';
  return (
    <>
      {(match.error || game.error || logoutError) && (
        <p role="alert" className="my-4 border border-accent p-3">
          {match.error || game.error || logoutError}
        </p>
      )}
      {game.roomId ? (
        <>
          <p role="status" className="my-3">
            {game.connection === 'open' ? '接続済み' : '接続を確認しています。'}
          </p>
          {game.snapshot && <GameBoard game={game} />}
          {(game.connection === 'stopped' || game.connection === 'idle') && (
            <Button onClick={game.reconnect}>再接続</Button>
          )}
          {!game.snapshot || game.snapshot.phase === 'WAITING' ? (
            <Button className="mt-5" onClick={match.cancel} disabled={match.busy}>
              待機を取り消す
            </Button>
          ) : null}
          {finished && (
            <Button className="mt-5" onClick={game.leave}>
              次のマッチングへ
            </Button>
          )}
        </>
      ) : (
        <Panel title="自動マッチング">
          <p className="mt-3">
            同じ大会の参加者を探します。
            {match.players ? `${match.players}人` : '設定人数'}
            の接続がそろうと、自動で出題します。開始前は取り消せます。
          </p>
          {match.rules && (
            <p className="mt-3">
              {match.rules.correctAnswersToWin}問先取・{match.rules.mistakesToDisqualify}
              回お手つきで失格。
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void match.join(name);
            }}
          >
            <TextField
              id="match-name"
              label="表示名"
              autoComplete="nickname"
              maxLength={24}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="flex flex-wrap gap-3">
              <Button type="submit" tone="primary" disabled={match.busy}>
                マッチングする
              </Button>
              <Button onClick={match.resume} disabled={match.busy}>
                参加中の試合へ戻る
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <p className="mt-6 text-sm text-muted">
        結果のDB保存・ランキングは1Dで対応予定です。
      </p>
      <Button
        className="mt-5"
        disabled={match.busy || auth.busy}
        onClick={async () => {
          setLogoutError('');
          try {
            await match.logout();
            await auth.logout();
          } catch {
            setLogoutError(
              '退出を確認できませんでした。通信を確認して再度お試しください。',
            );
          }
        }}
      >
        ログアウト
      </Button>
    </>
  );
}
