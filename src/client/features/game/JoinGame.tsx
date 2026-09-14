import { useState } from 'react';
import matchmaking from '../../../../config/matchmaking.json';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import type { Game } from './useGame';

export default function JoinGame({ game }: { game: Game }) {
  const [name, setName] = useState('');
  const [room, setRoom] = useState('1');
  const [players, setPlayers] = useState(String(matchmaking.playersPerMatch));
  const [question, setQuestion] = useState('1');
  const [showSelections, setShowSelections] = useState(true);

  return (
    <Panel title="試合に参加する">
      <p className="mt-3 text-sm text-muted">
        問題はDBから取得します。別のブラウザーでも同じルーム番号・人数・問題番号・回答表示設定を指定してください。全員が接続すると出題します。同じブラウザーの別タブは同じ参加者になります。
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void game.join({
            room: `room-${room}`,
            name,
            players: Number(players),
            questionIndex: Number(question) - 1,
            showSelections,
          });
        }}
      >
        <TextField
          id="player-name"
          label="表示名"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={24}
          autoComplete="nickname"
        />
        <div className="grid gap-x-5 sm:grid-cols-3">
          <TextField
            id="room-number"
            label="ルーム番号（1〜16）"
            type="number"
            min={1}
            max={16}
            required
            value={room}
            onChange={(event) => setRoom(event.target.value)}
          />
          <TextField
            id="player-count"
            label="人数（2〜4人）"
            type="number"
            min={2}
            max={4}
            required
            value={players}
            onChange={(event) => setPlayers(event.target.value)}
          />
          <TextField
            id="question-number"
            label="最初の問題番号（DBセット内）"
            type="number"
            min={1}
            max={100}
            required
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </div>

        <TextField
          id="show-selections"
          label="回答者が選んだ文字を全員に表示する（試合共通）"
          type="checkbox"
          checked={showSelections}
          onChange={(event) => setShowSelections(event.target.checked)}
          className="size-5 accent-accent"
        />

        <Button type="submit" tone="primary" disabled={game.connection === 'connecting'}>
          参加する
        </Button>
      </form>
    </Panel>
  );
}
