import { expect, it } from 'vitest';
import {
  activeSanction,
  blocks,
  parseSanction,
  type Sanction,
} from '../src/shared/moderation';

const now = Date.parse('2026-09-26T00:00:00Z');
const timeout = {
  kind: 'timeout',
  restrictions: [],
  expiresAt: new Date(now + 60000).toISOString(),
};
it('タイムアウトの1分・30日境界と組織全体のBAN専用を検査する', () => {
  expect(parseSanction(timeout, false, now).expiresAt).toBe(timeout.expiresAt);
  expect(
    parseSanction({ ...timeout, preparedAt: now }, false, now + 10000).expiresAt,
  ).toBe(timeout.expiresAt);
  expect(() =>
    parseSanction({ ...timeout, preparedAt: now }, false, now + 60000),
  ).toThrow();
  expect(() =>
    parseSanction(
      { ...timeout, expiresAt: new Date(now + 59999).toISOString() },
      false,
      now,
    ),
  ).toThrow();
  expect(() =>
    parseSanction(
      { ...timeout, expiresAt: new Date(now + 30 * 86400000 + 1).toISOString() },
      false,
      now,
    ),
  ).toThrow();
  expect(() => parseSanction(timeout, true, now)).toThrow();
  expect(() =>
    parseSanction({ kind: 'partial', restrictions: [], expiresAt: null }, false, now),
  ).toThrow();
  expect(() =>
    parseSanction(
      { kind: 'partial', restrictions: ['ranked', 'ranked'], expiresAt: null },
      false,
      now,
    ),
  ).toThrow();
});
it('期限切れ・解除は別の独立した制限を解除しない', () => {
  const timeoutSanction = {
    ...timeout,
    id: 'a',
    instanceId: 'i',
    actorId: 'p',
    reason: 'r',
    revokedAt: null,
    revision: 1,
  } as Sanction;
  const partialSanction = {
    ...timeoutSanction,
    id: 'b',
    kind: 'partial',
    restrictions: ['submit'],
    expiresAt: null,
  } as Sanction;
  expect(blocks(timeoutSanction, 'ranked', now)).toBe(true);
  expect(activeSanction(timeoutSanction, now + 60000)).toBe(false);
  expect(blocks(partialSanction, 'submit', now + 60000)).toBe(true);
  expect(blocks(partialSanction, 'ranked', now)).toBe(false);
  expect(
    activeSanction({ ...partialSanction, revokedAt: new Date(now).toISOString() }, now),
  ).toBe(false);
});
