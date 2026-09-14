import DebugPage from '../pages/DebugPage';
import GamePage from '../pages/GamePage';
import MatchPage from '../pages/MatchPage';
import { DEBUG_PATH, GAME_PATH, LOCAL_GAME_PATH } from './paths';

export const routes = [
  { path: '/', redirectTo: GAME_PATH },
  { path: DEBUG_PATH, component: DebugPage },
  { path: GAME_PATH, component: MatchPage },
  { path: LOCAL_GAME_PATH, component: GamePage },
] as const;
