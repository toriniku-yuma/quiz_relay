import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import ConfigurationPanel from '../src/client/features/debug/ConfigurationPanel';
import {
  type ConfigurationStatus,
  loadConfigurationStatus,
} from '../src/client/features/debug/useConfigurationStatus';

const mocks = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), overview: vi.fn() }));
vi.mock('../src/client/features/auth/client', () => ({
  setupAuth: async () => ({ auth: { getSession: mocks.session, getUser: mocks.user } }),
}));
vi.mock('../src/client/features/organization/useOrganization', () => ({
  organizationRequest: mocks.overview,
}));
beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
  mocks.user.mockReset().mockResolvedValue({
    data: {
      user: { email: 'self@example.test', user_metadata: { full_name: '検証管理者' } },
    },
    error: null,
  });
  mocks.overview.mockReset().mockResolvedValue({
    enabled: true,
    organization: { id: 'org', name: 'テスト組織' },
    account: { actorId: 'actor', administrator: true },
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
  mocks.session.mockResolvedValue({ data: { session: null }, error: null });
  expect(await loadConfigurationStatus()).toBeNull();
  expect(mocks.overview).not.toHaveBeenCalled();
  expect(render(null)).toContain('ログインすると');
});
it('Authの任意metadataを管理者権限として扱わない', async () => {
  mocks.user.mockResolvedValue({
    data: {
      user: { email: 'self@example.test', user_metadata: { administrator: true } },
    },
    error: null,
  });
  mocks.overview.mockResolvedValue({
    enabled: true,
    organization: { id: 'org', name: '組織' },
    account: { actorId: 'actor', administrator: false },
    instances: [],
  });
  const html = render(await loadConfigurationStatus());
  expect(html).toContain('self@example.test');
  expect(html).toContain('組織管理者ではありません');
  expect(html).not.toContain('管理者名（ログイン本人）');
});
it('初回設定未完了と組織機能無効を区別する', async () => {
  mocks.overview.mockResolvedValue({
    enabled: true,
    setup: { subject: 'self', eligible: true },
    instances: [],
  });
  expect(render(await loadConfigurationStatus())).toContain(
    '初回管理者設定を完了できます',
  );
  mocks.overview.mockResolvedValue({ enabled: false, instances: [] });
  expect(render(await loadConfigurationStatus())).toContain('組織機能が無効');
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
