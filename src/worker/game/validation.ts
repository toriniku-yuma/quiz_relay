import type { Command } from '../../shared/game';

const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function parseCommand(message: string | ArrayBuffer): Command | null {
  if (typeof message !== 'string' || new TextEncoder().encode(message).length > 2048)
    return null;

  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (
    !record(value) ||
    !id(value.commandId) ||
    !id(value.matchId) ||
    !id(value.questionId) ||
    !record(value.payload)
  )
    return null;
  if (Object.keys(value).sort().join(',') !== 'commandId,matchId,payload,questionId,type')
    return null;
  if (value.type === 'buzz' && Object.keys(value.payload).length === 0)
    return value as Command;
  if (
    value.type !== 'choose' ||
    Object.keys(value.payload).sort().join(',') !== 'attemptId,choiceId,panelId' ||
    !id(value.payload.attemptId) ||
    !id(value.payload.panelId) ||
    !id(value.payload.choiceId)
  )
    return null;

  return value as Command;
}

export function parseJoin(value: unknown) {
  if (
    !record(value) ||
    typeof value.name !== 'string' ||
    (value.showSelections !== undefined && typeof value.showSelections !== 'boolean') ||
    !value.name.trim() ||
    value.name.length > 24 ||
    !Number.isInteger(value.questionIndex) ||
    Number(value.questionIndex) < 0 ||
    Number(value.questionIndex) >= 12 ||
    !Number.isInteger(value.players) ||
    Number(value.players) < 2 ||
    Number(value.players) > 4
  )
    return null;

  return {
    name: value.name.trim(),
    showSelections: value.showSelections !== false,
    questionIndex: Number(value.questionIndex),
    players: Number(value.players),
  };
}

export function parseSync(message: string | ArrayBuffer) {
  if (message === 'sync') return { lastSeq: null, matchId: null };
  if (typeof message !== 'string' || message.length > 256) return null;
  try {
    const value: unknown = JSON.parse(message);
    if (
      !record(value) ||
      value.type !== 'sync' ||
      !(value.matchId === null || id(value.matchId)) ||
      !(
        value.lastSeq === null ||
        (Number.isSafeInteger(value.lastSeq) && Number(value.lastSeq) >= 0)
      )
    )
      return null;
    return {
      lastSeq: value.lastSeq as number | null,
      matchId: value.matchId as string | null,
    };
  } catch {
    return null;
  }
}
