import { type ComponentProps, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import OrganizationPanel from '../src/client/features/organization/OrganizationPanel';
import type { useOrganization } from '../src/client/features/organization/useOrganization';
import type { Sanction } from '../src/shared/moderation';
import type { OrganizationOverview } from '../src/shared/organization';
import { defaultCasualSettings } from '../src/shared/rooms';

const controls = vi.hoisted(() => ({
  remove: undefined as (() => void) | undefined,
  disabled: false,
}));
vi.mock('../src/client/components/Button', async (original) => {
  const { default: Button } =
    await original<typeof import('../src/client/components/Button')>();
  return {
    default: (props: ComponentProps<typeof Button>) => {
      if (props.children === 'お気に入りから外す') {
        controls.remove = props.onClick as (() => void) | undefined;
        controls.disabled = !!props.disabled;
      }
      return createElement(Button, props);
    },
  };
});
beforeEach(() => {
  controls.remove = undefined;
  controls.disabled = false;
});

it('探す一覧は未追加先も表示し、追加済みの行で解除できる', () => {
  const organization = {
    data: {
      organization: { id: 'organization', name: '組織' },
      account: { actorId: 'actor', administrator: false, displayName: '登録名' },
      addedInstanceIds: ['added'],
      sanctions: [],
      instances: ['added', 'new'].map((id) => ({
        id,
        name: id,
        state: 'published',
        permissions: [],
      })),
    },
    error: '',
    busy: false,
    loadFailed: false,
    refresh: vi.fn(),
    mutate: vi.fn(),
    version: 0,
    moreAccounts: vi.fn(),
  } as ReturnType<typeof useOrganization>;
  const markup = renderToStaticMarkup(createElement(OrganizationPanel, { organization }));
  expect(markup).toContain('利用可能なインスタンス');
  expect(markup).toContain('お気に入りに追加');
  expect(markup).toContain('お気に入り登録済み');
  expect(markup).toContain('お気に入りから外す');
  expect(markup).toContain('/game/?instance=new');
  expect(markup).toContain('/game/?instance=added');
  expect(markup).toContain('/casual/?instance=new');
  expect(markup).toContain('/rooms/?instance=new');
});

it.each([
  {
    instance: { rankedPauseReason: '停止' },
    restrictions: [],
    modes: ['casual', 'rooms'],
  },
  { instance: { casualPauseReason: '停止' }, restrictions: [], modes: ['game'] },
  {
    instance: { casualConfig: { ...defaultCasualSettings, enabled: false } },
    restrictions: [],
    modes: ['game', 'rooms'],
  },
  { instance: {}, restrictions: ['casual'], modes: ['game'] },
  { instance: {}, restrictions: ['rooms'], modes: ['game', 'casual', 'rooms'] },
] as {
  instance: Partial<OrganizationOverview['instances'][number]>;
  restrictions: Sanction['restrictions'];
  modes: string[];
}[])(
  'インスタンス一覧は利用可能な対戦種別だけを表示する: %j',
  ({ instance, restrictions, modes }) => {
    const organization = {
      data: {
        account: { actorId: 'actor', administrator: false, displayName: '登録名' },
        addedInstanceIds: [],
        sanctions: restrictions.length
          ? [
              {
                id: 'restriction',
                actorId: 'actor',
                instanceId: 'target',
                kind: 'partial',
                restrictions,
                reason: '制限',
                expiresAt: null,
                revokedAt: null,
                revision: 1,
              },
            ]
          : [],
        instances: [
          {
            id: 'target',
            name: '対象',
            state: 'published',
            permissions: [],
            ...instance,
          },
        ],
      },
      error: '',
      busy: false,
      loadFailed: false,
      mutate: vi.fn(),
      refresh: vi.fn(),
      version: 0,
      moreAccounts: vi.fn(),
    } as ReturnType<typeof useOrganization>;

    const markup = renderToStaticMarkup(
      createElement(OrganizationPanel, { organization }),
    );
    for (const mode of ['game', 'casual', 'rooms']) {
      expect(markup.includes(`/${mode}/?instance=target`)).toBe(modes.includes(mode));
    }
    expect(markup).toContain('お気に入りに追加');
  },
);

it.each([
  { state: 'archived', administrator: false },
  { state: 'archived', administrator: true },
  { state: 'preparing', administrator: false },
  { state: undefined, administrator: false },
] as const)(
  '利用できないお気に入りは対戦リンクを出さず解除できる: %j',
  ({ state, administrator }) => {
    const organization = {
      data: {
        organization: { id: 'organization', name: '組織' },
        account: { actorId: 'actor', administrator },
        addedInstanceIds: ['unavailable'],
        instances: state
          ? [{ id: 'unavailable', name: '登録済みの対象', state, permissions: [] }]
          : [],
      },
      error: '',
      busy: false,
      loadFailed: false,
      mutate: vi.fn(),
      refresh: vi.fn(),
      version: 0,
      moreAccounts: vi.fn(),
    } as ReturnType<typeof useOrganization>;
    const markup = renderToStaticMarkup(
      createElement(OrganizationPanel, { organization }),
    );
    expect(markup).toContain(state ? '登録済みの対象' : '利用できないインスタンス');
    expect(markup).toContain('現在は利用できません。');
    expect(markup.match(/お気に入りから外す/g)).toHaveLength(1);
    expect(markup).not.toContain('お気に入りに追加</button>');
    expect(markup).not.toContain('/game/?instance=unavailable');
    expect(controls.remove).toBeDefined();
    controls.remove?.();
    expect(organization.mutate).toHaveBeenCalledExactlyOnceWith(
      '/api/organization/instances/selection',
      { id: 'unavailable', added: false },
    );

    organization.busy = true;
    renderToStaticMarkup(createElement(OrganizationPanel, { organization }));
    expect(controls.disabled).toBe(true);
  },
);

it('全件管理は未追加・利用不可の先も表示し、個人のお気に入り操作を混ぜない', () => {
  const organization = {
    data: {
      organization: { id: 'organization', name: '組織' },
      account: { actorId: 'actor', administrator: true },
      addedInstanceIds: ['archived'],
      instances: (['preparing', 'archived'] as const).map((state) => ({
        id: state,
        name: `${state}の対象`,
        state,
        permissions: [],
      })),
    },
    error: '',
    busy: false,
    loadFailed: false,
    mutate: vi.fn(),
    refresh: vi.fn(),
    version: 0,
    moreAccounts: vi.fn(),
  } as ReturnType<typeof useOrganization>;
  const markup = renderToStaticMarkup(
    createElement(OrganizationPanel, { organization, management: true }),
  );
  expect(markup).toContain('preparingの対象');
  expect(markup).toContain('archivedの対象');
  expect(markup).not.toContain('お気に入りから外す');
  expect(markup).not.toContain('お気に入りに追加</button>');
});
