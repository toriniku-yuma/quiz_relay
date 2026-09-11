import { routes } from './routes';

export function rootRedirect(url: URL) {
  const route = routes.find((candidate) => candidate.path === url.pathname);

  return route && 'redirectTo' in route ? route.redirectTo + url.search + url.hash : null;
}
