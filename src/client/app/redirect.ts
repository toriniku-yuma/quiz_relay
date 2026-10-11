import { hasAuthCallback } from '../features/auth/callback';
import { DEBUG_PATH, GAME_PATH } from './paths';

export function rootRedirect(url: URL, authReturn?: string) {
  if (url.pathname === '/' && hasAuthCallback(url) && authReturn === DEBUG_PATH)
    return DEBUG_PATH + url.search + url.hash;
  if (url.pathname === '/') return GAME_PATH + url.search + url.hash;
  return null;
}
