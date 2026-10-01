import { questionPages } from '../features/questions/pages';
import CasualPage from '../pages/CasualPage';
import DebugPage from '../pages/DebugPage';
import GamePage from '../pages/GamePage';
import MatchPage from '../pages/MatchPage';
import ProfilePage from '../pages/ProfilePage';
import QuestionsPage from '../pages/QuestionsPage';
import RoomsPage from '../pages/RoomsPage';
import UsersPage from '../pages/UsersPage';
import {
  CASUAL_PATH,
  DEBUG_PATH,
  GAME_PATH,
  LOCAL_GAME_PATH,
  PROFILE_PATH,
  ROOMS_PATH,
  USERS_PATH,
} from './paths';

export const routes = [
  { path: ROOMS_PATH, component: RoomsPage },
  { path: CASUAL_PATH, component: CasualPage },
  { path: USERS_PATH, component: UsersPage },
  { path: PROFILE_PATH, component: ProfilePage },
  ...Object.values(questionPages).map(({ path }) => ({ path, component: QuestionsPage })),
  { path: '/', redirectTo: GAME_PATH },
  { path: DEBUG_PATH, component: DebugPage },
  { path: GAME_PATH, component: MatchPage },
  { path: LOCAL_GAME_PATH, component: GamePage },
] as const;
