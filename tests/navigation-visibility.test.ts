import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import Navigation from '../src/client/app/AppNavigation';

const state = vi.hoisted(() => ({
  administrator: false,
  permissions: [] as ('questions' | 'authors' | 'users')[],
  addedInstanceIds: [] as string[],
}));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({
    auth: { user: { user_metadata: {}, email: 'test@example.test' }, busy: false },
    organization: {
      data: {
        enabled: true,
        account: { administrator: state.administrator, actorId: 'test' },
        organization: { name: '組織' },
        addedInstanceIds: state.addedInstanceIds,
        instances: [
          {
            id: 'prepared',
            name: '準備中の対象',
            state: 'preparing',
            permissions: state.permissions,
          },
        ],
      },
    },
    url: new URL('https://quiz.example/game/?instance=prepared'),
  }),
}));

it('一般ユーザーには組織管理・開発ツールを表示せず、管理者には表示する', () => {
  state.administrator = false;
  const member = renderToStaticMarkup(createElement(Navigation));
  expect(member).not.toContain('開発ツール');
  expect(member).not.toContain('組織管理');
  expect(member).toContain('アカウント');

  state.administrator = true;
  const admin = renderToStaticMarkup(createElement(Navigation));
  expect(admin).toContain('開発ツール');
  expect(admin).toContain('組織管理');
  expect(admin).not.toContain('<details');
});

it('権限や直接URLではお気に入りに自動登録せず、明示的に追加した先だけを切替メニューに表示する', () => {
  state.administrator = true;
  state.addedInstanceIds = [];
  const empty = renderToStaticMarkup(createElement(Navigation));
  expect(empty).toContain('お気に入りはまだありません。');
  expect(empty).not.toContain('data-instance-switch');
  expect(empty).toContain('ランクマッチ');

  state.addedInstanceIds = ['prepared'];
  expect(renderToStaticMarkup(createElement(Navigation))).toContain(
    'data-instance-switch',
  );

  state.administrator = false;
  state.permissions = [];
  expect(renderToStaticMarkup(createElement(Navigation))).not.toContain(
    'data-instance-switch',
  );
  state.addedInstanceIds = [];
});

it('準備中の通常対戦・履歴は対象の運営者だけに表示する', () => {
  state.administrator = false;
  state.permissions = [];
  expect(renderToStaticMarkup(createElement(Navigation))).not.toContain('ランクマッチ');
  for (const permission of ['questions', 'authors', 'users'] as const) {
    state.permissions = [permission];
    const markup = renderToStaticMarkup(createElement(Navigation));
    expect(markup).toContain('ランクマッチ');
    expect(markup).toContain('対戦履歴');
    expect(markup).toContain('href="/history/?instance=prepared"');
    expect(markup).toContain('href="/ranking/?instance=prepared"');
  }
  state.permissions = [];
  state.administrator = true;
  expect(renderToStaticMarkup(createElement(Navigation))).toContain('ランクマッチ');
});
