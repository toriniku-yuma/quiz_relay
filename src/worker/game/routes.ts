import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_PATHS, GAME_PREFIX } from '../../shared/api-paths';
import type { Env } from '../env';
import { authorizeLocalGame } from './authorize';
import { connectGame, joinGame, rejectLargeGameBody } from './handlers';

const game = new Hono<{ Bindings: Env }>();

game.use(`${GAME_PREFIX}/*`, authorizeLocalGame);
game.post(
  API_PATHS.gameJoin,
  bodyLimit({ maxSize: 1024, onError: rejectLargeGameBody }),
  joinGame,
);
game.get(API_PATHS.gameSocket, connectGame);

export default game;
