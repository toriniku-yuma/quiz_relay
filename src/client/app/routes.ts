import { questionPages } from '../features/questions/pages';
import CasualPage from '../pages/CasualPage';
import DebugPage from '../pages/DebugPage';
import ExternalInstancePage from '../pages/ExternalInstancePage';
import FederationPage from '../pages/FederationPage';
import ForeignParticipationPage from '../pages/ForeignParticipationPage';
import GamePage from '../pages/GamePage';
import HistoryPage from '../pages/HistoryPage';
import MatchPage from '../pages/MatchPage';
import ParticipationAuthorizationPage from '../pages/ParticipationAuthorizationPage';
import ProfilePage from '../pages/ProfilePage';
import QuestionSharingPage from '../pages/QuestionSharingPage';
import QuestionsPage from '../pages/QuestionsPage';
import RankingPage from '../pages/RankingPage';
import RoomsPage from '../pages/RoomsPage';
import UsersPage from '../pages/UsersPage';
import {
  AUTHORIZE_PATH,
  CASUAL_PATH,
  DEBUG_PATH,
  EXTERNAL_PATH,
  FEDERATION_PATH,
  FOREIGN_PATH,
  GAME_PATH,
  HISTORY_PATH,
  LOCAL_GAME_PATH,
  PROFILE_PATH,
  QUESTION_SHARING_PATH,
  RANKING_PATH,
  ROOMS_PATH,
  USERS_PATH,
} from './paths';

export const routes = [
  { path: FOREIGN_PATH, component: ForeignParticipationPage },
  { path: AUTHORIZE_PATH, component: ParticipationAuthorizationPage },
  { path: FEDERATION_PATH, component: FederationPage },
  { path: QUESTION_SHARING_PATH, component: QuestionSharingPage },
  { path: EXTERNAL_PATH, component: ExternalInstancePage },
  { path: HISTORY_PATH, component: HistoryPage },
  { path: RANKING_PATH, component: RankingPage },
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
