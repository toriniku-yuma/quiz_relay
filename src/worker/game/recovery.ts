import type { RoomEvent, Snapshot } from '../../shared/game';

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
  return events.filter(({ at }) => at >= now - 60000).slice(-512);
}

export function replayEvents(
  events: RoomEvent[],
  roomSeq: number,
  lastSeq: number,
  now: number,
) {
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0 || lastSeq > roomSeq) return null;
  const replay = events.filter(
    (event) => event.roomSeq > lastSeq && event.at >= now - 60000,
  );
  if (
    replay.length !== roomSeq - lastSeq ||
    replay.some((event, index) => event.roomSeq !== lastSeq + index + 1)
  )
    return null;
  return replay;
}
