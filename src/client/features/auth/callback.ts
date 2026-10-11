export function hasAuthCallback(url: URL) {
  const hash = new URLSearchParams(url.hash.slice(1));

  return (
    url.searchParams.get('clerk-callback') === '1' ||
    url.searchParams.has('code') ||
    url.searchParams.has('error') ||
    hash.has('error')
  );
}

export function readAuthReturn() {
  try {
    return safeAuthReturn(localStorage.getItem('quiz-relay-auth-return') ?? undefined);
  } catch {
    return undefined;
  }
}

import { participationId, participationTarget } from '../../../shared/participation';
import {
  AUTHORIZE_PATH,
  CASUAL_PATH,
  DEBUG_PATH,
  GAME_PATH,
  ROOMS_PATH,
} from '../../app/paths';

export function safeAuthReturn(value: string | undefined) {
  if (!value || value.length > 2048) return undefined;
  if (value === DEBUG_PATH) return value;
  try {
    const url = new URL(value, 'https://app.invalid');
    if (url.origin !== 'https://app.invalid' || url.hash || !value.startsWith('/'))
      return undefined;
    if (url.pathname === AUTHORIZE_PATH && participationTarget(url, true)) return value;
    if (url.pathname === ROOMS_PATH && url.searchParams.has('room')) return value;
    if (
      [GAME_PATH, CASUAL_PATH, ROOMS_PATH].includes(url.pathname) &&
      [...url.searchParams.keys()].every((key) => key === 'instance') &&
      url.searchParams.getAll('instance').length <= 1 &&
      (!url.searchParams.has('instance') ||
        participationId(url.searchParams.get('instance')))
    )
      return value;
  } catch {
    /* Invalid saved paths cannot redirect a login. */
  }
  return undefined;
}
