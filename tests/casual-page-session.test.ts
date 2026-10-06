import type { ReactElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import MatchLobby from '../src/client/features/matchmaking/MatchLobby';
import OrganizationGateway from '../src/client/features/organization/OrganizationGateway';
import CasualLobby from '../src/client/features/rooms/CasualLobby';
import CasualPage from '../src/client/pages/CasualPage';

const mocks = vi.hoisted(() => ({
  active: null as string | null,
  effects: [] as Array<() => void>,
  url: new URL('https://quiz.test/casual/?instance=instance-a'),
  statusMode: 'ranked',
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: () => [
    mocks.active,
    (next: string) => {
      mocks.active = next;
    },
  ],
  useEffect: (effect: () => void) => mocks.effects.push(effect),
  useCallback: (callback: unknown) => callback,
}));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({
    auth: { user: { id: 'self' }, ready: true },
    url: mocks.url,
    matchStatus: { mode: mocks.statusMode, retained: false, instanceId: 'instance-a' },
    setMatchStatus: vi.fn(),
    organization: {
      data: {
        enabled: true,
        account: { administrator: false },
        instances: ['instance-a', 'instance-b'].map((id) => ({ id, state: 'published' })),
      },
    },
  }),
}));
beforeEach(() => {
  mocks.active = null;
  mocks.effects = [];
});
function lobby(
  node: unknown,
  component: typeof CasualLobby | typeof MatchLobby = CasualLobby,
): ReactElement<{ instanceId: string; targetInstanceId: string }> | undefined {
  if (Array.isArray(node))
    return node.map((child) => lobby(child, component)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  const element = node as ReactElement<{ children?: unknown }>;
  return element.type === component
    ? (element as ReturnType<typeof lobby>)
    : lobby(element.props?.children, component);
}

it('他モードの終了状態や閲覧先の変更でカジュアルの参加処理・接続を破棄しない', () => {
  mocks.url = new URL('https://quiz.test/casual/?instance=instance-a');
  CasualPage();
  mocks.effects.at(-1)?.();
  const first = lobby(CasualPage());
  expect(first?.props.instanceId).toBe('instance-a');
  for (const next of ['/game/', '/casual/?instance=instance-b']) {
    mocks.url = new URL(next, mocks.url);
    const page = CasualPage();
    mocks.effects.at(-1)?.();
    const current = lobby(page);
    expect(current?.key).toBe(first?.key);
    expect(current?.props.instanceId).toBe('instance-a');
  }
  expect(lobby(CasualPage())?.props.targetInstanceId).toBe('instance-b');
});

it.each(['ranked', 'casual'])(
  '%sの終了表示が残っていても閲覧先の変更でランクの参加処理・接続を破棄しない',
  (mode) => {
    mocks.statusMode = mode;
    mocks.url = new URL('https://quiz.test/game/?instance=instance-a');
    OrganizationGateway();
    mocks.effects.at(-1)?.();
    const first = lobby(OrganizationGateway(), MatchLobby);
    expect(first?.props.instanceId).toBe('instance-a');
    for (const next of ['/profile/', '/game/?instance=instance-b']) {
      mocks.url = new URL(next, mocks.url);
      const page = OrganizationGateway();
      mocks.effects.at(-1)?.();
      const current = lobby(page, MatchLobby);
      expect(current?.key).toBe(first?.key);
      expect(current?.props.instanceId).toBe('instance-a');
    }
    expect(lobby(OrganizationGateway(), MatchLobby)?.props.targetInstanceId).toBe(
      'instance-b',
    );
  },
);
