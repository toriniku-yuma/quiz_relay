import { useEffect, useRef, useState } from 'react';
import MenuToggle from '../components/MenuToggle';
import type { Auth } from '../features/auth/useAuth';
import { useOrganization } from '../features/organization/useOrganization';
import NotificationBell from '../features/questions/NotificationBell';
import { useGuest } from '../features/rooms/useGuest';
import CasualPage from '../pages/CasualPage';
import MatchPage from '../pages/MatchPage';
import NotFoundPage from '../pages/NotFoundPage';
import ProfilePage from '../pages/ProfilePage';
import RoomsPage from '../pages/RoomsPage';
import Navigation from './AppNavigation';
import { AppContext, type MatchStatus } from './context';
import { gameHref, handleNavigation, useLocation } from './navigation';
import { CASUAL_PATH, DEBUG_PATH, GAME_PATH, LOCAL_GAME_PATH, ROOMS_PATH } from './paths';
import { routes } from './routes';
import { useMobileMenu } from './useMobileMenu';

export default function Application({ auth }: { auth: Auth }) {
  const organization = useOrganization(!!auth.user);
  const url = useLocation();
  const guest = useGuest(
    auth.ready &&
      !auth.user &&
      (url.searchParams.get('guest') === '1' ||
        (url.pathname === ROOMS_PATH && url.searchParams.has('room'))),
  );
  const [matchStatus, setMatchStatus] = useState<MatchStatus | null>(null);

  const content = useRef<HTMLDivElement>(null);
  const href = url.href;
  const pageLocation = [
    url.pathname,
    url.searchParams.get('instance'),
    url.searchParams.get('view'),
    url.searchParams.get('id'),
    url.searchParams.get('actor'),
  ].join(':');
  const menu = useMobileMenu(href);
  const path = `${url.pathname.replace(/\/$/, '')}/`;
  const route = routes.find((candidate) => candidate.path === path);
  const Page = route && 'component' in route ? route.component : NotFoundPage;
  const active = matchStatus?.roomId && !matchStatus.finished ? matchStatus : null;
  const needsProfile =
    !!organization.data?.account && !organization.data.account.displayName && !active;
  const activeName =
    organization.data?.instances.find((instance) => instance.id === active?.instanceId)
      ?.name ?? '参加中のインスタンス';

  useEffect(() => {
    document.addEventListener('click', handleNavigation);
    return () => document.removeEventListener('click', handleNavigation);
  }, []);

  useEffect(() => {
    if (!pageLocation && !needsProfile) return;
    window.scrollTo(0, 0);
    if (menu.dialog.current?.open || document.querySelector('[popover]:popover-open'))
      return;
    const heading = content.current?.querySelector<HTMLElement>(
      '[data-page]:not([hidden]) h1',
    );
    heading?.focus({ preventScroll: true });
  }, [pageLocation, needsProfile, menu.dialog]);

  return (
    <AppContext.Provider
      value={{ auth, organization, url, matchStatus, setMatchStatus, guest }}
    >
      <a
        href="#page-content"
        className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-paper focus:p-4"
      >
        本文へ移動
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden h-dvh w-72 overflow-hidden border-r border-line bg-key lg:block">
        <Navigation />
      </aside>
      <div className="min-h-dvh lg:pl-72">
        <div className="sticky top-0 z-20 border-b border-line bg-paper">
          <div className="flex items-center gap-4 px-4 py-3">
            <div className="lg:hidden">
              <MenuToggle expanded={menu.expanded} onClick={menu.open} />
            </div>
            <span className="font-extrabold tracking-widest lg:sr-only">QUIZ RELAY</span>
            {auth.user && <NotificationBell />}
          </div>
          {active && (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 bg-key px-4 py-3"
            >
              <span className="min-w-0 break-words font-bold">対戦中：{activeName}</span>
              <a
                className="shrink-0 font-bold underline"
                href={active.href ?? gameHref(active.instanceId)}
              >
                対戦に戻る
              </a>
            </div>
          )}
        </div>
        {auth.message && (
          <p role="status" className="mx-4 my-4 border border-line p-3">
            {auth.message}
          </p>
        )}
        <div ref={content} id="page-content" tabIndex={-1}>
          <div data-page hidden={path !== GAME_PATH || needsProfile}>
            <MatchPage />
          </div>
          <div data-page hidden={path !== CASUAL_PATH || needsProfile}>
            <CasualPage />
          </div>
          <div data-page hidden={path !== ROOMS_PATH || needsProfile}>
            <RoomsPage />
          </div>
          {needsProfile && (
            <div data-page>
              <ProfilePage />
            </div>
          )}
          {![GAME_PATH, ROOMS_PATH, CASUAL_PATH].includes(path) && !needsProfile && (
            <div data-page>
              {(path === DEBUG_PATH || path === LOCAL_GAME_PATH) &&
              !organization.data?.account?.administrator ? (
                <main className="p-8">
                  <h1 tabIndex={-1} className="text-2xl font-bold outline-none">
                    開発ツール
                  </h1>
                  <p className="mt-4">
                    {!auth.ready || (auth.user && !organization.data)
                      ? '権限を確認しています。'
                      : 'この画面は組織管理者のみ利用できます。'}
                  </p>
                </main>
              ) : (
                <Page />
              )}
            </div>
          )}
        </div>
      </div>
      <dialog
        ref={menu.dialog}
        id="mobile-menu"
        onCancel={(event) => {
          event.preventDefault();
          menu.close();
        }}
        aria-label="メニュー"
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none overflow-hidden open:flex flex-col w-80 max-w-[90vw] border-r border-line bg-key p-0 text-ink backdrop:bg-black/40"
      >
        <div className="flex shrink-0 items-center gap-4 border-b border-line/15 px-4 py-3">
          <MenuToggle expanded={menu.expanded} onClick={() => menu.close()} />
          <span className="font-extrabold tracking-widest">QUIZ RELAY</span>
        </div>
        <Navigation mobile />
      </dialog>
    </AppContext.Provider>
  );
}
