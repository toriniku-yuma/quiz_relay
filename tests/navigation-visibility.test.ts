import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import Navigation from '../src/client/app/AppNavigation';

const state = vi.hoisted(() => ({ administrator: false }));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({
    auth: { user: { user_metadata: {}, email: 'test@example.test' }, busy: false },
    organization: {
      data: {
        enabled: true,
        account: { administrator: state.administrator, actorId: 'test' },
        organization: { name: '組織' },
        instances: [],
      },
    },
    url: new URL('https://quiz.example/game/'),
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
