import { GAME_PATH } from './paths';

export function rootRedirect(url: URL) {
  if (url.pathname === '/') return GAME_PATH + url.search + url.hash;
  return null;
}
