import { useSyncExternalStore } from 'react';
import { questionPages } from '../features/questions/pages';
import {
  CASUAL_PATH,
  DEBUG_PATH,
  GAME_PATH,
  HISTORY_PATH,
  LOCAL_GAME_PATH,
  PROFILE_PATH,
  RANKING_PATH,
  ROOMS_PATH,
  USERS_PATH,
} from './paths';

const paths: readonly string[] = [
  HISTORY_PATH,
  RANKING_PATH,
  CASUAL_PATH,
  ROOMS_PATH,
  USERS_PATH,
  PROFILE_PATH,
  GAME_PATH,
  DEBUG_PATH,
  LOCAL_GAME_PATH,
  ...Object.values(questionPages).map((page) => page.path),
];

export function isAppUrl(url: URL, current: URL) {
  return (
    url.origin === current.origin && paths.includes(`${url.pathname.replace(/\/$/, '')}/`)
  );
}

export function gameHref(instanceId = '', view = '') {
  const query = new URLSearchParams();
  if (instanceId) query.set('instance', instanceId);
  if (view) query.set('view', view);
  return `${GAME_PATH}${query.size ? `?${query}` : ''}`;
}

export function navigate(href: string, replace = false) {
  if (replace) history.replaceState(null, '', href);
  else history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

export function useLocation() {
  return new URL(useSyncExternalStore(subscribe, () => location.href));
}

export function handleNavigation(event: MouseEvent) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (
    !(link instanceof HTMLAnchorElement) ||
    link.hasAttribute('download') ||
    (link.target && link.target !== '_self')
  )
    return;
  const url = new URL(link.href);
  if (!isAppUrl(url, new URL(location.href)) || url.hash) return;
  event.preventDefault();
  if (!link.hasAttribute('data-instance-switch')) {
    for (const popup of document.querySelectorAll<HTMLElement>('[popover]:popover-open'))
      popup.hidePopover();
  }
  document.dispatchEvent(
    new CustomEvent('app:navigate', {
      detail: { keepMenuOpen: link.hasAttribute('data-instance-switch'), href: url.href },
    }),
  );
  if (url.href !== location.href) navigate(url.href);
}
