import { canAccessInstance } from '../../shared/organization';
import { type QuestionPage, questionHref } from '../features/questions/pages';
import '../styles/menu-scrollbar.css';
import { useState } from 'react';
import Button from '../components/Button';
import MenuPopover from '../components/MenuPopover';
import GuestName from '../features/rooms/GuestName';
import { useApp } from './context';
import { externalInstanceHref, gameHref } from './navigation';
import {
  CASUAL_PATH,
  DEBUG_PATH,
  FEDERATION_PATH,
  GAME_PATH,
  HISTORY_PATH,
  LOCAL_GAME_PATH,
  PROFILE_PATH,
  QUESTION_SHARING_PATH,
  RANKING_PATH,
  ROOMS_PATH,
  USERS_PATH,
} from './paths';
import { useSidebarScroll } from './useSidebarScroll';

export default function Navigation({ mobile = false }: { mobile?: boolean }) {
  const { auth, organization, url, guest, externalInstances, foreignLogin, logout } =
    useApp();
  const [guestOptions, setGuestOptions] = useState(false);
  const nav = useSidebarScroll();
  const data = organization.data;
  const foreign = !auth.user ? foreignLogin?.data : null;
  const instanceId = url.searchParams.get('instance') ?? '';
  const selected = auth.user
    ? data?.instances.find((instance) => instance.id === instanceId)
    : undefined;
  const selectedForeign = foreign?.instances.find(
    (instance) => instance.id === instanceId,
  );
  const candidates = (data?.instances ?? []).filter(
    (instance) =>
      data?.addedInstanceIds?.includes(instance.id) &&
      canAccessInstance(instance, data.account?.administrator),
  );
  const view = url.searchParams.get('view') ?? '';
  const peerOrigin = url.searchParams.get('peer') ?? '';
  const externalCandidates =
    externalInstances?.data?.instances.filter((row) => row.available && row.favorite) ??
    [];
  const selectedExternal = externalCandidates.find(
    (row) => row.peerOrigin === peerOrigin && row.instanceId === instanceId,
  );
  const path = `${url.pathname.replace(/\/$/, '')}/`;
  const current = (href: string) => {
    const target = new URL(href, url);
    return (
      target.pathname === path &&
      (target.searchParams.get('instance') ?? '') === instanceId &&
      (target.searchParams.get('view') ?? '') === view &&
      (target.searchParams.get('peer') ?? '') === peerOrigin
    );
  };
  const linkClass = (href: string) =>
    `block rounded px-3 py-2.5 break-words ${current(href) ? 'bg-paper font-bold text-ink' : 'hover:bg-paper'}`;
  const items = foreign
    ? [
        { label: 'ランクマッチ', href: gameHref(instanceId) },
        { label: 'カジュアルマッチ', href: `${CASUAL_PATH}?instance=${instanceId}` },
        { label: '部屋', href: `${ROOMS_PATH}?instance=${instanceId}` },
        { label: '対戦履歴', href: `${HISTORY_PATH}?instance=${instanceId}` },
      ]
    : canAccessInstance(selected, data?.account?.administrator) ||
        data?.enabled === false ||
        guest?.data?.id
      ? [
          ...(auth.user ? [{ label: 'ランクマッチ', href: gameHref(instanceId) }] : []),
          {
            label: 'カジュアルマッチ',
            href: `${CASUAL_PATH}?instance=${instanceId}${auth.user ? '' : '&guest=1'}`,
          },
          {
            label: '部屋',
            href: `${ROOMS_PATH}?instance=${instanceId}${auth.user ? '' : '&guest=1'}`,
          },
          {
            label: '対戦履歴',
            href: `${HISTORY_PATH}?instance=${instanceId}${auth.user ? '' : '&guest=1'}`,
          },
          ...(auth.user
            ? [{ label: 'ランキング', href: `${RANKING_PATH}?instance=${instanceId}` }]
            : []),
        ]
      : [];
  const administrator = !!auth.user && data?.account?.administrator === true;
  const moderated =
    data?.instances.filter((instance) => instance.permissions.includes('users')) ?? [];
  const usersHref = administrator
    ? USERS_PATH
    : `${USERS_PATH}?instance=${encodeURIComponent(moderated.find((instance) => instance.id === instanceId)?.id ?? moderated[0]?.id ?? '')}`;
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
      items:
        review || manageAuthors
          ? [
              questionLink('management', '問題管理'),
              ...(review
                ? [
                    {
                      label: '共有問題',
                      href: `${QUESTION_SHARING_PATH}?instance=${instanceId}`,
                    },
                  ]
                : []),
            ]
          : [],
    },
    {
      title: 'インスタンス管理',
      management: true,
      items: [
        ...(selected && administrator
          ? [
              { label: 'インスタンス設定', href: gameHref(instanceId, 'settings') },
              {
                label: '問題・結果の共有設定',
                href: `${FEDERATION_PATH}?instance=${instanceId}`,
              },
              questionLink('settings', '投稿設定'),
              questionLink('selection', '出題設定'),
            ]
          : []),
      ],
    },
  ].filter((section) => section.items.length > 0);
  const name =
    foreign?.account.name ??
    (auth.user
      ? (data?.account?.displayName ?? '表示名未登録')
      : (guest?.data?.name ?? 'ログインしていません'));
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
        {(auth.user || foreign) && (
          <div className="pb-5">
            <h2 className="mb-2 px-3 text-base font-bold">組織・インスタンス</h2>
            <p className="mb-2 px-3 text-base break-words">
              {foreign?.organizationName ?? data?.organization?.name ?? '組織'}
            </p>
            <p className="mb-2 px-3 text-base font-bold text-muted">インスタンス切替</p>
            <div className="grid gap-3">
              <MenuPopover
                title={
                  selectedForeign?.name ??
                  selectedExternal?.name ??
                  selected?.name ??
                  'インスタンスを選ぶ'
                }
              >
                <ul className="mt-2 grid gap-1">
                  {!foreign &&
                    candidates.length === 0 &&
                    externalCandidates.length === 0 && (
                      <li className="px-3 py-2.5 text-muted">
                        お気に入りはまだありません。
                      </li>
                    )}
                  {(foreign ? [] : candidates).map((instance) => (
                    <li key={instance.id}>
                      <a
                        data-instance-switch
                        className={linkClass(gameHref(instance.id))}
                        href={gameHref(instance.id)}
                        aria-current={
                          !peerOrigin && instance.id === instanceId ? 'true' : undefined
                        }
                      >
                        {!peerOrigin && instance.id === instanceId ? '✓ ' : ''}
                        {instance.name}
                        {instance.state === 'preparing' ? '（準備中）' : ''}
                      </a>
                    </li>
                  ))}
                  {foreign?.instances.map((instance) => (
                    <li key={instance.id}>
                      <a
                        data-instance-switch
                        className={linkClass(gameHref(instance.id))}
                        href={gameHref(instance.id)}
                        aria-current={instance.id === instanceId ? 'true' : undefined}
                      >
                        {instance.id === instanceId ? '✓ ' : ''}
                        {instance.name}
                      </a>
                    </li>
                  ))}
                  {(foreign ? [] : externalCandidates).map((instance) => (
                    <li key={`${instance.peerOrigin}:${instance.instanceId}`}>
                      <a
                        data-instance-switch
                        className={linkClass(
                          externalInstanceHref(instance.peerOrigin, instance.instanceId),
                        )}
                        href={externalInstanceHref(
                          instance.peerOrigin,
                          instance.instanceId,
                          !peerOrigin
                            ? selected?.id
                            : (url.searchParams.get('source') ?? undefined),
                        )}
                        aria-current={selectedExternal === instance ? 'true' : undefined}
                      >
                        {selectedExternal === instance ? '✓ ' : ''}
                        {instance.name}（{instance.organization}）
                      </a>
                    </li>
                  ))}
                </ul>
              </MenuPopover>
              <a className={linkClass(GAME_PATH)} href={GAME_PATH}>
                インスタンス一覧
              </a>
            </div>
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
        {!auth.user && !foreign && (
          <a className={linkClass(GAME_PATH)} href={GAME_PATH}>
            ログイン
          </a>
        )}
        {auth.user && (administrator || moderated.length > 0) && (
          <div className="grid gap-5 border-t border-line pt-4 pb-5">
            <section>
              <h2 className="px-3 py-2 text-base font-bold">組織管理</h2>
              {administrator && (
                <a
                  className={linkClass(gameHref('', 'organization'))}
                  href={gameHref('', 'organization')}
                  aria-current={
                    view === 'organization' && path === GAME_PATH ? 'page' : undefined
                  }
                >
                  組織設定
                </a>
              )}
              <a className={linkClass(usersHref)} href={usersHref}>
                ユーザー管理
              </a>
              {administrator && (
                <a className={linkClass(FEDERATION_PATH)} href={FEDERATION_PATH}>
                  外部組織との連携
                </a>
              )}
            </section>
            {administrator && (
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
            )}
          </div>
        )}
      </div>
      <div className="-mx-5 -mb-5 shrink-0 border-t border-line/20 bg-paper px-5 pt-4 pb-5">
        <h2 className="text-base font-bold">ユーザー</h2>
        <p className="my-3 text-base break-words">
          {typeof name === 'string' ? name : 'ログイン中'}
          {foreign && (
            <span className="mt-1 block text-sm">
              所属：{foreign.account.organizationName}
            </span>
          )}
        </p>
        {(auth.user || foreign) && (
          <MenuPopover title="アカウント" upward>
            {auth.user && (
              <a className="block px-3 py-2.5 underline" href={PROFILE_PATH}>
                マイページ
              </a>
            )}
            {foreign && (
              <Button
                className="m-3"
                onClick={auth.google}
                disabled={auth.busy || foreignLogin?.busy}
              >
                この組織のアカウントでログイン・登録
              </Button>
            )}
            <Button
              className="m-3"
              onClick={logout ?? auth.logout}
              disabled={auth.busy || foreignLogin?.busy}
            >
              ログアウト
            </Button>
          </MenuPopover>
        )}
        {!auth.user && !foreign && guest?.data?.name && (
          <MenuPopover title="オプション" upward>
            <Button onClick={() => setGuestOptions(true)}>ゲスト名を変更</Button>
            <a className="block p-3 underline" href="/game/?guest=1">
              インスタンス一覧
            </a>
          </MenuPopover>
        )}
        {guestOptions && guest && (
          <GuestName
            name={guest.data?.name ?? ''}
            onClose={() => setGuestOptions(false)}
            onSaved={async () => {
              await guest.refresh();
              setGuestOptions(false);
            }}
          />
        )}
      </div>
    </nav>
  );
}
