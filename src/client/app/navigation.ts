import { useMemo, useSyncExternalStore } from 'react';
import { questionPages } from '../features/questions/pages';
import {
  AUTHORIZE_PATH,
  CASUAL_PATH,
  DEBUG_PATH,
  EXTERNAL_PATH,
  FEDERATION_PATH,
  FOREIGN_PATH,
  GAME_PATH,
  HISTORY_PATH,
  LOCAL_GAME_PATH,
  PROFILE_PATH,
  QUESTION_SHARING_PATH,
  RANKING_PATH,
  ROOMS_PATH,
  USERS_PATH,
} from './paths';

const paths: readonly string[] = [
  FEDERATION_PATH,
  EXTERNAL_PATH,
  FOREIGN_PATH,
  AUTHORIZE_PATH,
  QUESTION_SHARING_PATH,
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
export function externalInstanceHref(
  peerOrigin: string,
  instanceId: string,
  sourceInstanceId = '',
) {
  return `${EXTERNAL_PATH}?${new URLSearchParams({ peer: peerOrigin, instance: instanceId, ...(sourceInstanceId ? { source: sourceInstanceId } : {}) })}`;
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
  const href = useSyncExternalStore(subscribe, () => location.href);
  return useMemo(() => new URL(href), [href]);
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
