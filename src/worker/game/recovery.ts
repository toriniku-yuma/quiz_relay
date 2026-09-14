import type { RoomEvent, Snapshot } from '../../shared/game';
import { settings } from '../../shared/settings';

export function appendEvent(
  events: RoomEvent[],
  previous: Snapshot | null,
  current: Snapshot,
  now: number,
) {
  const changes = Object.fromEntries(
    Object.entries(current).filter(
      ([key, value]) =>
        JSON.stringify(previous?.[key as keyof Snapshot]) !== JSON.stringify(value),
    ),
  ) as Partial<Snapshot>;
  events.push({ roomSeq: current.roomSeq, at: now, changes });
  return events
    .filter(({ at }) => at >= now - settings.game.eventRetentionMs)
    .slice(-settings.game.maxEvents);
}

export function replayEvents(
  events: RoomEvent[],
  roomSeq: number,
  lastSeq: number,
  now: number,
) {
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0 || lastSeq > roomSeq) return null;
  const replay = events.filter(
    (event) =>
      event.roomSeq > lastSeq && event.at >= now - settings.game.eventRetentionMs,
  );
  if (
    replay.length !== roomSeq - lastSeq ||
    replay.some((event, index) => event.roomSeq !== lastSeq + index + 1)
  )
    return null;
  return replay;
}
