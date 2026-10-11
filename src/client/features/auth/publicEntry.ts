import {
  AUTHORIZE_PATH,
  CASUAL_PATH,
  FOREIGN_PATH,
  GAME_PATH,
  HISTORY_PATH,
  ROOMS_PATH,
} from '../../app/paths';

export function publicPlayEntry(url: URL) {
  return (
    [FOREIGN_PATH, AUTHORIZE_PATH].includes(url.pathname) ||
    (url.pathname === ROOMS_PATH && url.searchParams.has('room')) ||
    ([GAME_PATH, CASUAL_PATH, ROOMS_PATH, HISTORY_PATH].includes(url.pathname) &&
      (url.searchParams.get('guest') === '1' ||
        (url.searchParams.has('instance') &&
          (url.pathname !== GAME_PATH || !url.searchParams.has('view')))))
  );
}
