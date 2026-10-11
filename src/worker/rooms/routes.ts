import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_PATHS } from '../../shared/api-paths.ts';
import { type AuthEnv, authenticate, sameOrigin } from '../auth/handlers.ts';
import {
  casual,
  guest,
  info,
  instances,
  list,
  optionalAuth,
  options,
  reports,
  results,
  roomActions,
  sets,
  settings,
  socket,
} from './handlers.ts';

const rooms = new Hono<AuthEnv>();
rooms.use('/api/play/*', sameOrigin);
rooms.use(
  '/api/play/*',
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (context) => context.json({ code: 'INVALID_SETUP' }, 413),
  }),
);
rooms.get(API_PATHS.roomSocket, socket);
rooms.post(API_PATHS.guest, guest);
rooms.post(API_PATHS.guestInstances, instances);
rooms.post(API_PATHS.personalSets, authenticate, sets);
rooms.post(API_PATHS.casualSettings, authenticate, settings);
rooms.use('/api/play/*', optionalAuth);
rooms.post(API_PATHS.roomInfo, info);
rooms.post(API_PATHS.casualConfig, casual);
rooms.post(API_PATHS.playResults, results);
rooms.post(API_PATHS.playReport, reports);
rooms.post(API_PATHS.casualJoin, casual);
rooms.post(API_PATHS.casualResume, casual);
rooms.post(API_PATHS.casualCancel, casual);
rooms.post(API_PATHS.rooms, list);
rooms.post(API_PATHS.roomOptions, options);
rooms.post(API_PATHS.roomCreate, roomActions);
rooms.post(API_PATHS.roomJoin, roomActions);
rooms.post(API_PATHS.roomView, roomActions);
rooms.post(API_PATHS.roomMutate, roomActions);
rooms.post(API_PATHS.roomOriginals, roomActions);
rooms.post(API_PATHS.roomGame, roomActions);
rooms.post(API_PATHS.roomLeave, roomActions);
export default rooms;
