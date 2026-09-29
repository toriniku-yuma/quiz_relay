import { afterEach, expect, it, vi } from 'vitest';
import { useActiveSanctions } from '../src/client/features/moderation/useActiveSanctions';
import type { Sanction } from '../src/shared/moderation';

const harness = vi.hoisted(() => ({
  now: 0,
  effect: undefined as undefined | (() => undefined | (() => void)),
}));
vi.mock('react', () => ({
  useState: () => [
    harness.now,
    (value: number) => {
      harness.now = value;
    },
  ],
  useEffect: (effect: () => undefined | (() => void)) => {
    harness.effect = effect;
  },
}));
afterEach(() => vi.useRealTimers());

it('期限ごとに表示を更新し、独立したBANを残して長い期限も再予約する', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
  harness.now = Date.now();
  const row: Sanction = {
    id: 'timeout',
    actorId: 'actor',
    instanceId: 'instance',
    kind: 'timeout',
    restrictions: [],
    reason: '検証',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    revokedAt: null,
    revision: 1,
  };
  const rows: Sanction[] = [
    row,
    { ...row, id: 'ban', kind: 'ban', expiresAt: null },
    { ...row, id: 'long', expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() },
  ];
  function render() {
    // biome-ignore lint/correctness/useHookAtTopLevel: 状態とeffectを差し替えて時刻による再描画を検証する。
    return useActiveSanctions(rows).map((item) => item.id);
  }
  expect(render()).toEqual(['timeout', 'ban', 'long']);
  harness.effect?.();
  vi.advanceTimersByTime(60000);
  expect(harness.now).toBe(Date.now());
  expect(render()).toEqual(['ban', 'long']);
  harness.effect?.();
  vi.advanceTimersByTime(2147483647);
  expect(render()).toEqual(['ban', 'long']);
  harness.effect?.();
  vi.advanceTimersByTime(30 * 86400000 - 60000 - 2147483647);
  expect(render()).toEqual(['ban']);
  expect(harness.effect?.()).toBeUndefined();
});
