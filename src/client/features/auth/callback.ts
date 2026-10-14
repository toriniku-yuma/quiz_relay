import { participationId, participationTarget } from '../../../shared/participation';
import {
  AUTHORIZE_PATH,
  CASUAL_PATH,
  DEBUG_PATH,
  GAME_PATH,
  ROOMS_PATH,
} from '../../app/paths';

export const AUTH_RETURN_KEY = 'quiz-relay-auth-return';

export function readAuthReturn() {
  try {
    return safeAuthReturn(localStorage.getItem(AUTH_RETURN_KEY) ?? undefined);
  } catch {
    return undefined;
  }
}

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
