import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import ConfigurationPanel from '../src/client/features/debug/ConfigurationPanel';
import {
  type ConfigurationStatus,
  loadConfigurationStatus,
} from '../src/client/features/debug/useConfigurationStatus';

const mocks = vi.hoisted(() => ({ user: vi.fn(), overview: vi.fn() }));
vi.mock('../src/client/features/auth/client', () => ({
  setupAuth: async () => ({ getUser: mocks.user }),
}));
vi.mock('../src/client/features/organization/useOrganization', () => ({
  organizationRequest: mocks.overview,
}));
beforeEach(() => {
  mocks.user.mockReset().mockResolvedValue({ id: 'user_fixture' });
  mocks.overview.mockReset().mockResolvedValue({
    organization: { id: 'org', name: 'テスト組織' },
    account: { actorId: 'actor', administrator: true, displayName: '検証管理者' },
    instances: [
      { id: 'instance', name: '初期インスタンス', state: 'preparing', permissions: [] },
    ],
  });
});
const render = (data: ConfigurationStatus, error = '') =>
  renderToStaticMarkup(
    createElement(ConfigurationPanel, {
      status: { data, error, busy: false, refresh: async () => {} },
    }),
  );
it('組織・インスタンス・本人の管理者名と公開状態が読める', async () => {
  const html = render(await loadConfigurationStatus());
  for (const text of [
    'テスト組織',
    '初期インスタンス',
    '検証管理者',
    '準備中',
    'このアカウントは組織管理者です',
  ])
    expect(html).toContain(text);
});
it('ログアウト時には組織情報を取得しない', async () => {
  mocks.user.mockResolvedValue(null);
  expect(await loadConfigurationStatus()).toBeNull();
  expect(mocks.overview).not.toHaveBeenCalled();
  expect(render(null)).toContain('ログインすると');
});
it('ログイン済みでもサーバーが管理者と返さなければ管理者として表示しない', async () => {
  mocks.overview.mockResolvedValue({
    organization: { id: 'org', name: '組織' },
    account: { actorId: 'actor', administrator: false },
    instances: [],
  });
  const html = render(await loadConfigurationStatus());
  expect(html).toContain('ログイン済み');
  expect(html).toContain('組織管理者ではありません');
  expect(html).not.toContain('管理者名（ログイン本人）');
});
it('初回設定未完了なら初回管理者設定を案内する', async () => {
  mocks.overview.mockResolvedValue({
    setup: { subject: 'self', eligible: true },
    instances: [],
  });
  expect(render(await loadConfigurationStatus())).toContain(
    '初回管理者設定を完了できます',
  );
});
it('取得失敗を未設定と誤表示せず、以前の管理者名も残さない', async () => {
  const old = await loadConfigurationStatus();
  mocks.overview.mockRejectedValue(new Error('組織情報を読み込めませんでした。'));
  await expect(loadConfigurationStatus()).rejects.toThrow(
    '組織情報を読み込めませんでした',
  );
  const html = render(old, '組織情報を読み込めませんでした。');
  expect(html).toContain('role="alert"');
  expect(html).not.toContain('検証管理者');
});
