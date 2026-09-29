import { canAccessInstance } from '../../shared/organization';
import { type QuestionPage, questionHref } from '../features/questions/pages';
import '../styles/menu-scrollbar.css';
import Button from '../components/Button';
import MenuPopover from '../components/MenuPopover';
import { useApp } from './context';
import { gameHref } from './navigation';
import {
  DEBUG_PATH,
  GAME_PATH,
  LOCAL_GAME_PATH,
  PROFILE_PATH,
  USERS_PATH,
} from './paths';
import { useSidebarScroll } from './useSidebarScroll';

export default function Navigation({ mobile = false }: { mobile?: boolean }) {
  const { auth, organization, url } = useApp();
  const nav = useSidebarScroll();
  const data = organization.data;
  const instanceId = url.searchParams.get('instance') ?? '';
  const selected = data?.instances.find((instance) => instance.id === instanceId);
  const view = url.searchParams.get('view') ?? '';
  const path = `${url.pathname.replace(/\/$/, '')}/`;
  const current = (href: string) => {
    const target = new URL(href, url);
    return (
      target.pathname === path &&
      (target.searchParams.get('instance') ?? '') === instanceId &&
      (target.searchParams.get('view') ?? '') === view
    );
  };
  const linkClass = (href: string) =>
    `block rounded px-3 py-2.5 break-words ${current(href) ? 'bg-paper font-bold text-ink' : 'hover:bg-paper'}`;
  const items =
    canAccessInstance(selected, data?.account?.administrator) || data?.enabled === false
      ? [
          { label: '対戦する', href: gameHref(instanceId) },
          { label: '対戦履歴・ランキング', href: gameHref(instanceId, 'history') },
        ]
      : [];
  const administrator = data?.account?.administrator === true;
  const review =
    !!selected && (administrator || selected.permissions.includes('questions'));
  const manageAuthors =
    !!selected && (administrator || selected.permissions.includes('authors'));
  const questionLink = (page: QuestionPage, label: string) => ({
    label,
    href: questionHref(page, instanceId),
  });
  const sections = [
    { title: '対戦', items },
    {
      title: '作問',
      items: selected
        ? [
            questionLink('mine', '自分の問題'),
            questionLink('new', '新規作成'),
            questionLink('import', 'JSON取込'),
            questionLink('qualification', '資格申請'),
          ]
        : [],
    },
    {
      title: '審査',
      management: true,
      items: review
        ? [
            questionLink('pending', '審査待ち'),
            questionLink('reports', '通報・再審議'),
            questionLink('categoryRequests', 'カテゴリ変更申請'),
          ]
        : [],
    },
    {
      title: '問題管理',
      management: true,
      items: review || manageAuthors ? [questionLink('management', '問題管理')] : [],
    },
    {
      title: 'インスタンス管理',
      management: true,
      items: [
        ...(selected && (administrator || selected.permissions.includes('users'))
          ? [
              {
                label: 'ユーザー管理',
                href: `${USERS_PATH}?instance=${encodeURIComponent(instanceId)}`,
              },
            ]
          : []),
        ...(selected && administrator
          ? [
              { label: 'インスタンス設定', href: gameHref(instanceId, 'settings') },
              questionLink('settings', '投稿設定'),
              questionLink('selection', '出題設定'),
            ]
          : []),
      ],
    },
  ].filter((section) => section.items.length > 0);
  const name =
    data?.account?.displayName ?? (auth.user ? '表示名未登録' : 'ログインしていません');
  const debugQuery = instanceId ? `?instance=${encodeURIComponent(instanceId)}` : '';

  return (
    <nav
      ref={nav}
      aria-label="メインメニュー"
      className={`flex flex-col overflow-hidden p-5 text-base [&_:focus-visible]:outline-ink [&_:focus-visible]:outline-2 ${mobile ? 'min-h-0 flex-1' : 'h-full min-h-0'}`}
    >
      {!mobile && (
        <a
          className="mb-5 shrink-0 px-3 text-lg font-extrabold tracking-widest"
          href={gameHref(instanceId)}
        >
          QUIZ RELAY
        </a>
      )}
      <div
        data-sidebar-scroll
        className="menu-scrollbar -mr-4 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-3"
      >
        {auth.user && (
          <div className="pb-5">
            <h2 className="mb-2 px-3 text-base font-bold">組織・インスタンス</h2>
            <p className="mb-2 px-3 text-base break-words">
              {data?.organization?.name ?? '組織'}
            </p>
            <p className="mb-2 px-3 text-base font-bold text-muted">インスタンス切替</p>
            <MenuPopover title={selected?.name ?? 'インスタンスを選ぶ'}>
              <ul className="mt-2 grid gap-1">
                {data?.instances.map((instance) => (
                  <li key={instance.id}>
                    <a
                      data-instance-switch
                      className={linkClass(gameHref(instance.id))}
                      href={gameHref(instance.id)}
                      aria-current={instance.id === instanceId ? 'true' : undefined}
                    >
                      {instance.id === instanceId ? '✓ ' : ''}
                      {instance.name}
                      {instance.state === 'preparing' ? '（準備中）' : ''}
                    </a>
                  </li>
                ))}
              </ul>
            </MenuPopover>
            <a className={linkClass(GAME_PATH)} href={GAME_PATH}>
              インスタンス一覧
            </a>
          </div>
        )}
        {sections.map((section, index) => (
          <section key={section.title} className="border-t border-line pt-4 pb-5">
            {section.management && !sections[index - 1]?.management && (
              <p className="mb-4 px-3 text-sm font-bold text-muted">管理</p>
            )}
            {section.title !== '問題管理' && (
              <h2 className="mb-2 px-3 text-base font-bold">{section.title}</h2>
            )}
            <ul className="grid gap-1">
              {section.items.map((item) => (
                <li key={item.href}>
                  <a
                    className={linkClass(item.href)}
                    href={item.href}
                    aria-current={current(item.href) ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {!auth.user && (
          <a className={linkClass(GAME_PATH)} href={GAME_PATH}>
            ログイン
          </a>
        )}
        {data?.account?.administrator && (
          <div className="grid gap-5 border-t border-line pt-4 pb-5">
            <section>
              <h2 className="px-3 py-2 text-base font-bold">組織管理</h2>
              <a
                className={linkClass(gameHref(instanceId, 'organization'))}
                href={gameHref(instanceId, 'organization')}
                aria-current={
                  view === 'organization' && path === GAME_PATH ? 'page' : undefined
                }
              >
                組織設定
              </a>
            </section>
            <div>
              <h2 className="px-3 py-2 text-base font-bold">開発ツール</h2>
              {import.meta.env.DEV && (
                <a
                  className={linkClass(LOCAL_GAME_PATH + debugQuery)}
                  href={LOCAL_GAME_PATH + debugQuery}
                  aria-current={path === LOCAL_GAME_PATH ? 'page' : undefined}
                >
                  対戦テスト
                </a>
              )}
              <a
                className={linkClass(DEBUG_PATH + debugQuery)}
                href={DEBUG_PATH + debugQuery}
                aria-current={path === DEBUG_PATH ? 'page' : undefined}
              >
                接続確認
              </a>
            </div>
          </div>
        )}
      </div>
      <div className="-mx-5 -mb-5 shrink-0 border-t border-line/20 bg-paper px-5 pt-4 pb-5">
        <h2 className="text-base font-bold">ユーザー</h2>
        <p className="my-3 text-base break-words">
          {typeof name === 'string' ? name : 'ログイン中'}
        </p>
        {auth.user && (
          <MenuPopover title="アカウント" upward>
            <a className="block px-3 py-2.5 underline" href={PROFILE_PATH}>
              マイページ
            </a>
            <Button className="m-3" onClick={auth.logout} disabled={auth.busy}>
              ログアウト
            </Button>
          </MenuPopover>
        )}
      </div>
    </nav>
  );
}
