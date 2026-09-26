import { questionPages } from '../features/questions/pages';
import DebugPage from '../pages/DebugPage';
import GamePage from '../pages/GamePage';
import MatchPage from '../pages/MatchPage';
import QuestionsPage from '../pages/QuestionsPage';
import { DEBUG_PATH, GAME_PATH, LOCAL_GAME_PATH } from './paths';

export const routes = [
  ...Object.values(questionPages).map(({ path }) => ({ path, component: QuestionsPage })),
  { path: '/', redirectTo: GAME_PATH },
  { path: DEBUG_PATH, component: DebugPage },
  { path: GAME_PATH, component: MatchPage },
  { path: LOCAL_GAME_PATH, component: GamePage },
] as const;
