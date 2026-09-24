import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_PATHS, MATCH_PREFIX } from '../../shared/api-paths';
import {
  type AuthEnv,
  authenticate,
  publicAuthConfig,
  sameOrigin,
} from '../auth/handlers';
import { existingInstanceContext, instanceContext } from '../organization/handlers';
import {
  cancelMatch,
  enterMatch,
  logoutActor,
  matchConfig,
  matchSocket,
  oversizedMatch,
} from './handlers';

const matchmaking = new Hono<AuthEnv>();
matchmaking.get(API_PATHS.publicAuthConfig, publicAuthConfig);
matchmaking.use(`${MATCH_PREFIX}/*`, sameOrigin);
matchmaking.use(
  `${MATCH_PREFIX}/*`,
  bodyLimit({ maxSize: 1024, onError: oversizedMatch }),
);
matchmaking.get(API_PATHS.matchSocket, matchSocket);
matchmaking.use(`${MATCH_PREFIX}/*`, authenticate);
matchmaking.post(API_PATHS.logout, logoutActor);
matchmaking.post(API_PATHS.matchResume, existingInstanceContext, enterMatch);
matchmaking.post(API_PATHS.matchCancel, existingInstanceContext, cancelMatch);
matchmaking.post(API_PATHS.matchLogout, existingInstanceContext, cancelMatch);
matchmaking.use(`${MATCH_PREFIX}/*`, instanceContext);

matchmaking.post(API_PATHS.matchConfig, matchConfig);
matchmaking.post(API_PATHS.matchJoin, enterMatch);
export default matchmaking;
