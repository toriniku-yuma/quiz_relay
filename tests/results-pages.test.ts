import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import App from '../src/client/app/App';
import { isAppUrl } from '../src/client/app/navigation';
import ResultsPanel from '../src/client/features/results/ResultsPanel';
import MatchPage from '../src/client/pages/MatchPage';
import type { ResultsOverview } from '../src/shared/results';

const mocks = vi.hoisted(() => ({
  result: '11111111-1111-4111-8111-111111111111',
  guest: false,
  ready: false,
  url: 'https://quiz.test/history/?instance=instance-a',
  query: vi.fn(),
  data: {
    ranking: [{ actorId: 'self', name: '本人', rating: 1000, rank: 1 }],
    history: [],
  } as ResultsOverview,
}));
vi.mock('../src/client/app/Application', () => ({ default: () => null }));
vi.mock('../src/client/features/auth/useAuth', () => ({
  useAuth: () => ({ ready: mocks.ready }),
}));
vi.mock('../src/client/features/organization/OrganizationGateway', () => ({
  default: () => 'ランク参加フォーム',
}));
vi.mock('../src/client/features/rooms/GuestInstances', () => ({
  default: () => 'ゲスト入口',
}));
vi.mock('../src/client/app/context', () => ({
  useApp: () => ({
    auth: { ready: mocks.ready, user: mocks.guest ? null : { id: 'self' } },
    organization: {
      data: {
        instances: [{ id: 'instance-a', name: '対象インスタンス' }],
        account: { actorId: 'self' },
      },
    },
    guest: { data: { id: 'guest-self' } },
    url: new URL(mocks.url),
  }),
}));
vi.mock('../src/client/features/results/useResults', () => ({
  useResults: (...args: unknown[]) => {
    mocks.query(...args);
    return {
      data: mocks.data,
      error: '',
      busy: false,
      refresh: vi.fn(),
      retry: vi.fn(),
      loadMore: vi.fn(),
    };
  },
}));
beforeEach(() => {
  mocks.guest = false;
  mocks.ready = false;
  mocks.url = 'https://quiz.test/history/?instance=instance-a';
  mocks.query.mockClear();
  mocks.data.self = { rank: 104, rating: 980 };
  mocks.data.history = [
    {
      matchId: mocks.result,
      kind: 'casual',
      outcome: 'draw',
      reason: 'exhausted',
      winnerId: null,
      finishedAt: '2026-10-01T00:00:00.000Z',
      ratingDelta: 0,
      correct: 2,
      mistakes: 1,
      players: [
        { id: 'self', name: '本人', correct: 2, mistakes: 1, ratingDelta: 0 },
        {
          id: 'guest',
          name: 'ゲスト参加者',
          correct: 1,
          mistakes: 0,
          ratingDelta: 0,
          guest: true,
        },
      ],
      questions: [
        {
          id: 'question',
          text: '問題本文',
          displayAnswer: '正答',
          readings: ['せいとう'],
          explanation: '',
          source: '',
        },
      ],
    },
  ];
});
it('一覧外の本人順位をランキング表の上に表示し、順位なしでもレートを表示する', () => {
  const ranking = renderToStaticMarkup(
    createElement(ResultsPanel, { instanceId: 'instance-a', section: 'ranking' }),
  );
  expect(ranking).toContain('あなたの順位：104位');
  expect(ranking).toContain('レート：980');
  expect(ranking.indexOf('あなたの順位：')).toBeLessThan(
    ranking.indexOf('aria-label="ランキング"'),
  );
  mocks.data.self = { rank: null, rating: 1000 };
  const empty = renderToStaticMarkup(
    createElement(ResultsPanel, { instanceId: 'instance-a', section: 'ranking' }),
  );
  expect(empty).toContain('あなたの順位：—');
  expect(empty).toContain('レート：1000');
});
it('本人順位はランク画面の見出し直後へ置き、別画面・ゲストでは取得しない', () => {
  mocks.ready = true;
  mocks.url = 'https://quiz.test/game/?instance=instance-a';
  const matching = renderToStaticMarkup(createElement(MatchPage));
  expect(matching.indexOf('対戦する')).toBeLessThan(matching.indexOf('あなたの順位：'));
  expect(matching.indexOf('あなたの順位：')).toBeLessThan(
    matching.indexOf('ランク参加フォーム'),
  );
  expect(mocks.query).toHaveBeenLastCalledWith('self', 'instance-a', { section: 'self' });
  for (const path of ['/casual/', '/rooms/', '/ranking/', '/game/?view=settings']) {
    mocks.url = `https://quiz.test${path}${path.includes('?') ? '&' : '?'}instance=instance-a`;
    mocks.query.mockClear();
    expect(renderToStaticMarkup(createElement(MatchPage))).not.toContain(
      'あなたの順位：',
    );
    expect(mocks.query).not.toHaveBeenCalled();
  }
  mocks.guest = true;
  mocks.url = 'https://quiz.test/game/?instance=instance-a';
  expect(renderToStaticMarkup(createElement(MatchPage))).not.toContain('あなたの順位：');
  expect(mocks.query).not.toHaveBeenCalled();
});
it('履歴は7列のテーブルと個別詳細リンク、ランキングは別画面で表示する', () => {
  const history = renderToStaticMarkup(
    createElement(ResultsPanel, { instanceId: 'instance-a' }),
  );
  expect(history).toContain('aria-label="対戦履歴"');
  for (const column of [
    '終了日時',
    '種別',
    '勝敗',
    '正解数',
    'お手つき',
    'レート差分',
    '詳細',
  ])
    expect(history).toContain(`>${column}</th>`);
  expect(history).toContain(`/history/?instance=instance-a&amp;result=${mocks.result}`);
  expect(history).not.toContain('問題本文');
  expect(history).not.toContain('aria-label="ランキング"');
  const ranking = renderToStaticMarkup(
    createElement(ResultsPanel, { instanceId: 'instance-a', section: 'ranking' }),
  );
  expect(ranking).toContain('aria-label="ランキング"');
  expect(ranking).not.toContain('aria-label="対戦履歴"');
  expect(
    isAppUrl(new URL('https://quiz.test/history/'), new URL('https://quiz.test/game/')),
  ).toBe(true);
  expect(
    isAppUrl(new URL('https://quiz.test/ranking/'), new URL('https://quiz.test/game/')),
  ).toBe(true);
});
it('詳細だけに振り返りを表示し、ゲスト参加者への個人通報を表示しない', () => {
  mocks.guest = true;
  const detail = renderToStaticMarkup(
    createElement(ResultsPanel, { instanceId: 'instance-a', matchId: mocks.result }),
  );
  expect(detail).toContain('問題本文');
  expect(detail).toContain('ゲスト参加者');
  expect(detail).not.toContain('ゲスト参加者を通報');
  expect(detail).toContain('/history/?instance=instance-a&amp;guest=1');
});
it('起動カバーは回転アイコンのみで、取得後のフェード中は操作を妨げない', () => {
  const loading = renderToStaticMarkup(createElement(App));
  expect(loading).toContain('animate-spin');
  expect(loading).not.toContain('ログイン状態を確認');
  mocks.ready = true;
  expect(renderToStaticMarkup(createElement(App))).toContain(
    'pointer-events-none opacity-0',
  );
});
