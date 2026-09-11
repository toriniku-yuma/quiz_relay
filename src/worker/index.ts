import { Hono } from 'hono';
import { API_PATHS } from '../shared/api-paths';
import type { Env } from './env';
import game from './game/routes';
import { handleError, health, notFound } from './http/handlers';
import probes from './probes/routes';

export { GameRoom } from './game/GameRoom';
export { Probe } from './probes/Probe';

const app = new Hono<{ Bindings: Env }>();

app.get(API_PATHS.health, health);

app.route('/', probes);
app.route('/', game);

app.notFound(notFound);

app.onError(handleError);

export default app;
