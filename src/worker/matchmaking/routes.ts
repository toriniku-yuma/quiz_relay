import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_PATHS, MATCH_PREFIX } from '../../shared/api-paths';
import {
  type AuthEnv,
  authenticate,
  publicAuthConfig,
  sameOrigin,
} from '../auth/handlers';
import {
  cancelMatch,
  enterMatch,
  matchConfig,
  matchSocket,
  oversizedMatch,
} from './handlers';

const matchmaking = new Hono<AuthEnv>();
matchmaking.get(API_PATHS.publicAuthConfig, publicAuthConfig);
matchmaking.use(`${MATCH_PREFIX}/*`, sameOrigin);
matchmaking.get(API_PATHS.matchSocket, matchSocket);
matchmaking.use(`${MATCH_PREFIX}/*`, authenticate);
matchmaking.use(
  `${MATCH_PREFIX}/*`,
  bodyLimit({ maxSize: 1024, onError: oversizedMatch }),
);
matchmaking.post(API_PATHS.matchConfig, matchConfig);
matchmaking.post(API_PATHS.matchJoin, enterMatch);
matchmaking.post(API_PATHS.matchResume, enterMatch);
matchmaking.post(API_PATHS.matchCancel, cancelMatch);
matchmaking.post(API_PATHS.matchLogout, cancelMatch);
export default matchmaking;
