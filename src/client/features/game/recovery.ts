import type { GameMessage, Snapshot } from '../../../shared/game';

export function applyGameUpdate(
  current: Snapshot | null,
  message: Extract<GameMessage, { type: 'state' | 'delta' }>,
): Snapshot | null {
  if (message.type === 'state') return message.snapshot;
  if (
    !current ||
    current.matchId !== message.matchId ||
    current.roomSeq !== message.fromSeq
  )
    return null;

  let next = current;
  for (const event of message.events) {
    if (event.roomSeq !== next.roomSeq + 1) return null;
    next = { ...next, ...event.changes, roomSeq: event.roomSeq };
  }
  return next.roomSeq === message.roomSeq && next.matchId === message.matchId
    ? next
    : null;
}

export function readGameSession(
  mode: 'local' | 'formal' = 'local',
  subject = '',
): {
  room: { id: string };
  snapshot: Snapshot | null;
} | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(
        mode === 'local' ? 'quiz-relay-1b-hiragana' : `quiz-relay-1c:${subject}`,
      ) ?? 'null',
    );
    if (
      !value ||
      !(mode === 'local' ? /^room-([1-9]|1[0-6])$/ : /^[0-9a-f-]{36}$/).test(
        value.room?.id,
      )
    )
      return null;
    return {
      room: value.room,
      snapshot:
        value.snapshot?.matchId &&
        Number.isSafeInteger(value.snapshot.roomSeq) &&
        Array.isArray(value.snapshot.players)
          ? value.snapshot
          : null,
    };
  } catch {
    return null;
  }
}

export function saveGameSession(
  room: { id: string } | null,
  snapshot: Snapshot | null,
  mode: 'local' | 'formal' = 'local',
  subject = '',
) {
  try {
    if (room)
      sessionStorage.setItem(
        mode === 'local' ? 'quiz-relay-1b-hiragana' : `quiz-relay-1c:${subject}`,
        JSON.stringify({ room, snapshot }),
      );
    else
      sessionStorage.removeItem(
        mode === 'local' ? 'quiz-relay-1b-hiragana' : `quiz-relay-1c:${subject}`,
      );
  } catch {
    /* ストレージを使えない場合も現在の接続は継続する。 */
  }
}
