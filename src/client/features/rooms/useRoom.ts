import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { RoomView } from '../../../shared/rooms';
import { connectGameSocket } from '../game/connection';
import { useGame } from '../game/useGame';
import { useMutation } from '../moderation/useMutation';
import { playRequest } from './api';

export function useRoom(identity: string) {
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
  const game = useGame('formal', `room:${identity}`, active?.instanceId ?? '');
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
    const result = await playRequest<{ room: RoomView }>(
      API_PATHS.roomView,
      { room: active.id },
      active.instanceId,
    );
    if (current.current === active) setRoom(result.room);
  }, [active]);
  const join = useCallback(
    (id: string, instanceId: string) => {
      const next = { id, instanceId };
      current.current = next;
      sessionStorage.setItem(key, JSON.stringify(next));
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
    sessionStorage.removeItem(key);
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
      playRequest(path, body, String((body as Record<string, unknown>).instanceId)),
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
    const url = new URL(API_PATHS.roomSocket, location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', active.id);
    url.searchParams.set('instance', active.instanceId);
    let live = true;
    const stillActive = () => live && current.current === active;
    void playRequest<{ room: RoomView }>(
      API_PATHS.roomView,
      { room: active.id },
      active.instanceId,
    )
      .then((r) => {
        if (stillActive()) setRoom(r.room);
      })
      .catch((e) => {
        if (stillActive()) setError(e.message);
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
      message: (data) => {
        if (!stillActive()) return false;
        const value = JSON.parse(data) as { type?: string; room?: RoomView };
        if (value.type !== 'lobby' || !value.room || value.room.id !== active.id)
          return false;
        setRoom(value.room);
        return true;
      },
    });
    return () => {
      live = false;
      disconnect();
    };
  }, [active, leave]);
  useEffect(() => {
    if (!room?.matchRoom || !active || room.id !== active.id) return;
    let live = true;
    void playRequest<{ room: string }>(
      API_PATHS.roomGame,
      { room: active.id },
      active.instanceId,
    )
      .then((r) => {
        if (live && current.current === active) attach(r.room);
      })
      .catch((e) => {
        if (live && current.current === active) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [room?.matchRoom, room?.id, active, attach]);
  return {
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
