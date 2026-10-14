import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MatchStatus } from '../src/client/app/context';
import type { Auth } from '../src/client/features/auth/useAuth';
import MatchLobby from '../src/client/features/matchmaking/MatchLobby';
import CasualLobby from '../src/client/features/rooms/CasualLobby';

const mocks = vi.hoisted(() => ({
  cursor: 0,
  dependencies: [] as unknown[][],
  effects: [] as Array<() => void>,
  url: new URL('https://quiz.test/game/?instance=instance-a'),
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
    const index = mocks.cursor++;
    const previous = mocks.dependencies[index];
    if (
      !previous ||
      dependencies.length !== previous.length ||
      dependencies.some((value, i) => !Object.is(value, previous[i]))
    ) {
      mocks.dependencies[index] = dependencies;
      mocks.effects.push(effect);
    }
  },
}));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({
    auth: { user: { id: 'self' } },
    organization: { data: { account: { displayName: '本人' } } },
    url: mocks.url,
  }),
}));
vi.mock('../src/client/features/matchmaking/useMatchmaking', () => ({
  useMatchmaking: () => mocks.match,
}));
beforeEach(() => {
  mocks.cursor = 0;
  mocks.dependencies = [];
  mocks.effects = [];
  mocks.url = new URL('https://quiz.test/game/?instance=instance-a');
  mocks.match.game.snapshot.result.storage = 'pending';
});
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
    mocks.cursor = 0;
    mocks.effects = [];
    renderToStaticMarkup(
      createElement(MatchLobby, {
        auth: { user: null, busy: false } as Auth,
        instanceId: 'instance-a',
        onStatus,
      }),
    );
    for (const effect of mocks.effects) effect();
  };
  render();
  expect(onStatus).toHaveBeenCalledOnce();
  expect(notifications).not.toHaveBeenCalled();
  active = { mode: 'casual', roomId: 'new-b' };
  onStatus.mockClear();

  mocks.match.game.snapshot.result.storage = 'confirmed';
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

it.each(['ranked', 'casual'] as const)(
  '%sの終了結果リンクは閲覧中のインスタンスだけに表示し、元へ戻ると再表示する',
  (mode) => {
    const path = mode === 'ranked' ? '/game/' : '/casual/';
    const markup = (target: string) => {
      mocks.url = new URL(`https://quiz.test${path}?instance=${target}`);
      return renderToStaticMarkup(
        mode === 'ranked'
          ? createElement(MatchLobby, {
              auth: { user: null, busy: false } as Auth,
              instanceId: 'instance-a',
              targetInstanceId: target,
            })
          : createElement(CasualLobby, {
              instanceId: 'instance-a',
              targetInstanceId: target,
            }),
      );
    };

    const other = markup('instance-b');
    expect(other).toContain('マッチングする');
    expect(other).not.toContain('/history/?instance=instance-a');
    const original = markup('instance-a');
    expect(original).toContain('/history/?instance=instance-a&amp;result=result-a');
    expect(original).toContain('対戦履歴');
    expect(mocks.match.game.roomId).toBe('old-a');
    expect(mocks.match.game.snapshot.result.id).toBe('result-a');
  },
);
