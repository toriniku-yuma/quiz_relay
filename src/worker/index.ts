import { Hono } from 'hono';
import { API_PATHS } from '../shared/api-paths';
import type { Env } from './env';
import game from './game/routes';
import { handleError, health, notFound } from './http/handlers';
import matchmaking from './matchmaking/routes';
import probes from './probes/routes';

export { GameRoom } from './game/GameRoom';
export { Matchmaker } from './matchmaking/Matchmaker';
export { Probe } from './probes/Probe';

const app = new Hono<{ Bindings: Env }>();

app.get(API_PATHS.health, health);

app.route('/', probes);
app.route('/', game);
app.route('/', matchmaking);

app.notFound(notFound);

app.onError(handleError);

export default app;
