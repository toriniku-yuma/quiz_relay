import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { Command, GameMessage, Panel, Snapshot } from '../../../shared/game';
import type { ResultsOverview } from '../../../shared/results';
import { settings } from '../../../shared/settings';
import { playRequest } from '../rooms/api';
import { type ConnectionStatus, connectGameSocket } from './connection';

import { applyGameUpdate, readGameSession, saveGameSession } from './recovery';

const messages: Record<string, string> = {
  GAME_DATABASE_UNAVAILABLE:
    '問題をDBから読み込めませんでした。しばらく待って再試行してください。',
  LOCAL_GAME_DISABLED: 'ローカル開発環境でのみ利用できます。',
  ORIGIN_REJECTED: '接続元が許可されていません。',
  INVALID_ROOM: 'ルーム番号は1〜16で指定してください。',
  INVALID_SETUP: '名前・人数・問題番号を確認してください。',
  SETUP_MISMATCH:
    'このルームの人数・問題番号・回答表示設定が違います。最初の参加者と同じ値を指定してください。',
  ROOM_CLOSED:
    '参加枠が埋まっているか、出題が始まっています。別のルームを選んでください。',
  RECONNECT_WAIT: '切断した参加者の復帰を待っています。',
  BUZZ_REJECTED: '今回は早押しを受け付けられませんでした。',
  PANEL_REJECTED: '解答権またはパネルの期限が変わりました。',
  CONNECTION_LIMIT: `同じ参加者の接続は${settings.game.maxConnectionsPerActor}タブまでです。他のタブを閉じてから参加してください。`,
  COMMAND_LIMIT: 'この試合であなたが送信できる入力の上限に達しました。',
  STALE_COMMAND: '出題が変わったため入力を受け付けませんでした。',
};

export function useGame(
  mode: 'local' | 'formal' = 'local',
  subject = '',
  instanceId = '',
  socketPath?: string,
) {
  const [saved] = useState(() => readGameSession(mode, subject));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(saved?.snapshot ?? null);
  const currentSnapshot = useRef<Snapshot | null>(saved?.snapshot ?? null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [actorId, setActorId] = useState('');
  const [connection, setConnection] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [room, setRoom] = useState<{ id: string; instanceId?: string } | null>(
    saved?.room ?? null,
  );
  const currentRoom = useRef(room);
  currentRoom.current = room;
  const socket = useRef<WebSocket | null>(null);
  const pendingCommand = useRef<Command | null>(null);
  const offset = useRef(0);
  const confirmedRoom = useRef<string | null>(null);
  const [parentRoomId, setParentRoomId] = useState<string | null>(null);
  const previousSession = useRef({ mode, subject });

  useEffect(() => {
    if (
      previousSession.current.mode !== mode ||
      previousSession.current.subject !== subject
    ) {
      previousSession.current = { mode, subject };
      const restored = readGameSession(mode, subject);
      currentRoom.current = restored?.room ?? null;
      currentSnapshot.current = restored?.snapshot ?? null;
      confirmedRoom.current = null;
      pendingCommand.current = null;
      setRoom(currentRoom.current);
      setSnapshot(currentSnapshot.current);
      setParentRoomId(null);
      setPanel(null);
      setActorId('');
      setPending(false);
      setConnection('idle');
      setError('');
      return;
    }
    if (mode !== 'formal' || !room || confirmedRoom.current === room.id) return;
    const activeRoom = room;
    const resultStorage = snapshot?.result?.storage;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const reservation = socketPath
      ? new URL(socketPath, location.origin).searchParams.get('reservation')
      : null;
    async function restoreResult() {
      try {
        const result = await playRequest<ResultsOverview>(
          `${API_PATHS.playResults}${reservation ? `?reservation=${encodeURIComponent(reservation)}` : ''}`,
          { section: 'history', matchId: activeRoom.id },
          activeRoom.instanceId ?? instanceId,
          controller.signal,
        );
        if (controller.signal.aborted || currentRoom.current !== room) return;
        const entry = result.history.find((entry) => entry.matchId === activeRoom.id);
        if (entry?.snapshot) {
          confirmedRoom.current = activeRoom.id;
          currentSnapshot.current = entry.snapshot;
          setSnapshot(entry.snapshot);
          setParentRoomId(entry.parentRoomId ?? null);
          if (result.actorId) setActorId(result.actorId);
          setPanel(null);
          pendingCommand.current = null;
          setPending(false);
          setError('');
          saveGameSession(room, entry.snapshot, mode, subject);
          socket.current?.close();
          setConnection('closed');
          return;
        }
      } catch (error) {
        if (controller.signal.aborted || currentRoom.current !== room) return;
        if (connection === 'stopped' || resultStorage)
          setError(
            error instanceof Error ? error.message : '結果を取得できませんでした。',
          );
      }
      if (connection === 'closed' || connection === 'stopped' || resultStorage)
        timer = setTimeout(() => void restoreResult(), 5000);
    }
    void restoreResult();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    room,
    mode,
    subject,
    instanceId,
    socketPath,
    connection,
    snapshot?.result?.storage,
  ]);

  useEffect(() => {
    if (!room || currentRoom.current !== room) return;
    const stillActive = () => currentRoom.current === room;

    const url = new URL(
      socketPath ?? (mode === 'local' ? API_PATHS.gameSocket : API_PATHS.matchSocket),
      location.origin,
    );
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', room.id);
    if (room.instanceId ?? instanceId)
      url.searchParams.set('instance', room.instanceId ?? instanceId);

    const disconnect = connectGameSocket(url, {
      status: (value) => {
        if (stillActive()) setConnection(value);
      },
      sync: () =>
        JSON.stringify({
          type: 'sync',
          lastSeq: currentSnapshot.current?.roomSeq ?? null,
          matchId: currentSnapshot.current?.matchId ?? null,
        }),
      error: (value) => {
        if (stillActive()) setError(value);
      },
      finished: () =>
        confirmedRoom.current === room.id ||
        (mode === 'local' && !!currentSnapshot.current?.result),
      released: () => {
        if (!stillActive()) return;
        if (mode === 'formal' && currentSnapshot.current?.phase !== 'WAITING') return;
        currentRoom.current = null;
        setRoom(null);
        if (!currentSnapshot.current?.result) {
          setSnapshot(null);
          currentSnapshot.current = null;
        }
        setPanel(null);
        pendingCommand.current = null;
        setPending(false);
        saveGameSession(null, null, mode, subject);
      },
      opened: (ws) => {
        if (!stillActive()) return;
        socket.current = ws;
        if (pendingCommand.current) ws.send(JSON.stringify(pendingCommand.current));
      },
      message: (data) => {
        if (!stillActive() || confirmedRoom.current === room.id) return false;
        const message = JSON.parse(data) as GameMessage;
        if (message.type === 'state' || message.type === 'delta') {
          const next = applyGameUpdate(currentSnapshot.current, message);
          if (!next) {
            currentSnapshot.current = null;
            socket.current?.send(
              JSON.stringify({ type: 'sync', lastSeq: null, matchId: null }),
            );
            return false;
          }
          currentSnapshot.current = next;
          saveGameSession(room, next, mode, subject);
          offset.current = message.serverTime - Date.now();
          setSnapshot(next);
          setPanel(message.panel);
          setActorId(message.actorId);
          return true;
        }

        if (message.type === 'ack') {
          if (message.reply.commandId === pendingCommand.current?.commandId) {
            pendingCommand.current = null;
            setPending(false);
          }
          if (!message.reply.ok)
            setError(messages[message.reply.code] ?? '入力を受け付けられませんでした。');
        } else setError(messages[message.code] ?? '通信内容を確認できませんでした。');
        return false;
      },
    });

    const ticker = setInterval(() => setClock(Date.now() + offset.current), 100);
    return () => {
      disconnect();
      clearInterval(ticker);
      socket.current = null;
    };
  }, [room, mode, subject, instanceId, socketPath]);

  async function join(input: {
    room: string;
    name: string;
    players: number;
    questionIndex: number;
    showSelections: boolean;
  }) {
    setError('');
    setConnection('connecting');
    try {
      const response = await fetch(
        `${API_PATHS.gameJoin}?room=${encodeURIComponent(input.room)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: input.name,
            players: input.players,
            questionIndex: input.questionIndex,
            showSelections: input.showSelections,
          }),
        },
      );
      const result = (await response.json()) as { code?: string };
      if (!response.ok)
        throw new Error(messages[result.code ?? ''] ?? '参加に失敗しました。');
      currentSnapshot.current = null;
      pendingCommand.current = null;
      setPending(false);
      setSnapshot(null);
      setPanel(null);
      const next = { id: input.room };
      currentRoom.current = next;
      setRoom(next);
      saveGameSession(next, null, mode, subject);
    } catch (error) {
      setError(error instanceof Error ? error.message : '接続に失敗しました。');
      setConnection('idle');
    }
  }

  const attach = useCallback(
    (id: string, connectedInstance?: string) => {
      setError('');
      confirmedRoom.current = null;
      setParentRoomId(null);
      currentSnapshot.current = null;
      pendingCommand.current = null;
      setPending(false);
      setSnapshot(null);
      setPanel(null);
      const next = {
        id,
        ...(connectedInstance ? { instanceId: connectedInstance } : {}),
      };
      currentRoom.current = next;
      setRoom(next);
      saveGameSession(next, null, mode, subject);
    },
    [mode, subject],
  );

  const leave = useCallback(() => {
    confirmedRoom.current = null;
    setParentRoomId(null);
    currentRoom.current = null;
    setRoom(null);
    setSnapshot(null);
    setPanel(null);
    currentSnapshot.current = null;
    pendingCommand.current = null;
    setPending(false);
    setConnection('idle');
    setError('');
    saveGameSession(null, null, mode, subject);
  }, [mode, subject]);

  function reconnect() {
    setError('');
    const next = currentRoom.current ? { ...currentRoom.current } : null;
    currentRoom.current = next;
    setRoom(next);
  }

  function send(type: Command['type'], payload: Command['payload'] = {}) {
    if (
      !snapshot ||
      socket.current?.readyState !== WebSocket.OPEN ||
      pendingCommand.current
    )
      return;

    const command: Command = {
      commandId: crypto.randomUUID(),
      matchId: snapshot.matchId,
      questionId: snapshot.questionId,
      type,
      payload,
    };
    pendingCommand.current = command;
    setPending(true);
    setError('');
    socket.current.send(JSON.stringify(command));
  }

  return {
    snapshot,
    parentRoomId,
    roomId: room?.id ?? null,
    roomInstanceId: room?.instanceId ?? instanceId,
    attach,
    panel,
    actorId,
    connection,
    error,
    pending,
    clock,
    join,
    send,
    reconnect,
    leave,
  };
}

export type Game = ReturnType<typeof useGame>;
