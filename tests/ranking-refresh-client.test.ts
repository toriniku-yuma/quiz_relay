import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { MatchStatus } from '../src/client/app/context';
import type { Auth } from '../src/client/features/auth/useAuth';
import MatchLobby from '../src/client/features/matchmaking/MatchLobby';

const h = vi.hoisted(() => ({
  cursor: 0,
  dependencies: [] as unknown[][],
  effects: [] as Array<() => void>,
  match: {
    game: {
      roomId: 'old-a',
      roomInstanceId: 'instance-a',
      snapshot: { phase: 'FINISHED', result: { id: 'result-a', storage: 'pending' } },
    },
    busy: false,
    viewing: false,
    error: '',
    rules: null,
    players: 2,
    join: vi.fn(),
    resume: vi.fn(),
    offerRestore: vi.fn(),
  },
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => void, dependencies: unknown[]) => {
    const index = h.cursor++;
    const previous = h.dependencies[index];
    if (
      !previous ||
      dependencies.length !== previous.length ||
      dependencies.some((value, i) => !Object.is(value, previous[i]))
    ) {
      h.dependencies[index] = dependencies;
      h.effects.push(effect);
    }
  },
}));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({
    auth: { user: { id: 'self' } },
    organization: { data: { enabled: true, account: { displayName: '本人' } } },
    url: new URL('https://quiz.test/game/?instance=instance-a'),
  }),
}));
vi.mock('../src/client/features/matchmaking/useMatchmaking', () => ({
  useMatchmaking: () => h.match,
}));
afterEach(() => vi.unstubAllGlobals());

it('遅い旧ランク結果の保存確定は順位だけ更新し、新参加先の状態を上書きしない', () => {
  vi.stubGlobal('window', new EventTarget());
  const notifications = vi.fn();
  window.addEventListener('results:refresh', notifications);
  let active = { mode: 'ranked', roomId: 'old-a' };
  const onStatus = vi.fn((status: MatchStatus) => {
    active = { mode: status.mode ?? '', roomId: status.roomId ?? '' };
  });
  const render = () => {
    h.cursor = 0;
    h.effects = [];
    renderToStaticMarkup(
      createElement(MatchLobby, {
        auth: { user: null, busy: false } as Auth,
        instanceId: 'instance-a',
        onStatus,
      }),
    );
    for (const effect of h.effects) effect();
  };
  render();
  expect(onStatus).toHaveBeenCalledOnce();
  expect(notifications).not.toHaveBeenCalled();
  active = { mode: 'casual', roomId: 'new-b' };
  onStatus.mockClear();

  h.match.game.snapshot.result.storage = 'confirmed';
  render();
  expect(onStatus).not.toHaveBeenCalled();
  expect(active).toEqual({ mode: 'casual', roomId: 'new-b' });
  expect(notifications).toHaveBeenCalledOnce();
  expect((notifications.mock.calls[0][0] as CustomEvent).detail).toEqual({
    instanceId: 'instance-a',
  });
  render();
  expect(notifications).toHaveBeenCalledOnce();
});
