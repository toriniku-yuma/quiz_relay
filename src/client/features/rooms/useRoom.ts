import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { RoomView } from '../../../shared/rooms';
import { connectGameSocket } from '../game/connection';
import { useGame } from '../game/useGame';
import { useMutation } from '../moderation/useMutation';
import { playRequest } from './api';

export function useRoom(
  identity: string,
  foreign?: { request: typeof playRequest; lobbySocket: string; gameSocket: string },
) {
  const request = foreign?.request ?? playRequest;
  const key = `quiz-relay-room:${identity}`;
  const [active, setActive] = useState<{ id: string; instanceId: string } | null>(() => {
    try {
      return identity ? JSON.parse(sessionStorage.getItem(key) ?? 'null') : null;
    } catch {
      return null;
    }
  });
  const [room, setRoom] = useState<RoomView | null>(null),
    [error, setError] = useState(''),
    [connection, setConnection] = useState('idle');
  const game = useGame(
    'formal',
    `room:${identity}`,
    active?.instanceId ?? '',
    foreign?.gameSocket,
  );
  const { attach } = game;
  const leaveGame = game.leave;
  const current = useRef(active);
  const [restored, setRestored] = useState(!!active);
  current.current = active;
  const isCurrent = useCallback(
    (id: unknown) => (current.current?.id ?? null) === id,
    [],
  );
  useEffect(() => {
    leaveGame();
    try {
      const saved = identity ? JSON.parse(sessionStorage.getItem(key) ?? 'null') : null;
      current.current = saved;
      setActive(saved);
      setRestored(!!saved);
    } catch {
      current.current = null;
      setActive(null);
    }
    setRoom(null);
  }, [identity, key, leaveGame]);
  const refresh = useCallback(async () => {
    if (!active) return;
    const result = await request<{ room: RoomView }>(
      API_PATHS.roomView,
      { room: active.id },
      active.instanceId,
    );
    if (current.current === active) setRoom(result.room);
  }, [active, request]);
  const join = useCallback(
    (id: string, instanceId: string) => {
      const next = { id, instanceId };
      current.current = next;
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* The live session does not require browser storage. */
      }
      setRoom(null);
      leaveGame();
      setActive(next);
      setRestored(false);
      setError('');
    },
    [key, leaveGame],
  );
  const leave = useCallback(() => {
    current.current = null;
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
    setActive(null);
    setRoom(null);
    leaveGame();
  }, [key, leaveGame]);
  const exit = useMutation(
    API_PATHS.roomLeave,
    (request) => {
      if (current.current?.id === request.room) leave();
    },
    (path, body) =>
      request(path, body, String((body as Record<string, unknown>).instanceId)),
  );
  const retryExit = useRef(exit.submit);
  retryExit.current = exit.submit;
  useEffect(() => {
    if (!exit.uncertain || exit.busy) return;
    const timer = setTimeout(() => void retryExit.current({}), 1500);
    return () => clearTimeout(timer);
  }, [exit.uncertain, exit.busy]);
  useEffect(() => {
    if (!active) return;
    const url = new URL(foreign?.lobbySocket ?? API_PATHS.roomSocket, location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', active.id);
    url.searchParams.set('instance', active.instanceId);
    let live = true,
      closed = false;
    const stillActive = () => live && current.current === active;
    void request<{ room: RoomView }>(
      API_PATHS.roomView,
      { room: active.id },
      active.instanceId,
    )
      .then((response) => {
        if (stillActive()) {
          closed = response.room.closed;
          setRoom(response.room);
        }
      })
      .catch((caughtError) => {
        if (!stillActive()) return;
        if (['ROOM_CLOSED', 'ROOM_NOT_FOUND'].includes(caughtError.code)) {
          leave();
          return;
        }
        setError(caughtError.message);
      });
    const disconnect = connectGameSocket(url, {
      sync: () => 'sync',
      opened: () => {},
      status: (value) => {
        if (stillActive()) setConnection(value);
      },
      error: (value) => {
        if (stillActive()) setError(value);
      },
      released: () => {
        if (stillActive()) leave();
      },
      finished: () => closed,
      message: (data) => {
        if (!stillActive()) return false;
        const value = JSON.parse(data) as { type?: string; room?: RoomView };
        if (value.type !== 'lobby' || !value.room || value.room.id !== active.id)
          return false;
        closed = value.room.closed;
        setRoom(value.room);
        return true;
      },
    });
    return () => {
      live = false;
      disconnect();
    };
  }, [active, leave, request, foreign?.lobbySocket]);
  useEffect(() => {
    if (!room?.matchRoom || !active || room.id !== active.id) return;
    let live = true;
    void request<{ room: string }>(
      API_PATHS.roomGame,
      { room: active.id },
      active.instanceId,
    )
      .then((response) => {
        if (live && current.current === active) attach(response.room);
      })
      .catch((caughtError) => {
        if (live && current.current === active) setError(caughtError.message);
      });
    return () => {
      live = false;
    };
  }, [room?.matchRoom, room?.id, active, attach, request]);
  return {
    request,
    active,
    room,
    game,
    error,
    connection,
    refresh,
    join,
    leave,
    exit,
    restored,
    isCurrent,
    resume: () => setRestored(false),
  };
}
