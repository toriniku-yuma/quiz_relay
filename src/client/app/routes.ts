import DebugPage from '../pages/DebugPage';
import GamePage from '../pages/GamePage';
import { DEBUG_PATH, GAME_PATH } from './paths';

export const routes = [
  { path: '/', redirectTo: DEBUG_PATH },
  { path: DEBUG_PATH, component: DebugPage },
  { path: GAME_PATH, component: GamePage },
] as const;
