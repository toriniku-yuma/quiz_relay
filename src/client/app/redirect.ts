import { hasAuthCallback } from '../features/auth/callback';
import { DEBUG_PATH } from './paths';
import { routes } from './routes';

export function rootRedirect(url: URL, authReturn?: string) {
  if (url.pathname === '/' && hasAuthCallback(url) && authReturn === DEBUG_PATH)
    return DEBUG_PATH + url.search + url.hash;
  const route = routes.find((candidate) => candidate.path === url.pathname);

  return route && 'redirectTo' in route ? route.redirectTo + url.search + url.hash : null;
}
