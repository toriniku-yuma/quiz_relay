import { Hono } from 'hono';
import { API_PATHS } from '../shared/api-paths';
import type { Env } from './env';
import game from './game/routes';
import { handleError, health, notFound } from './http/handlers';
import matchmaking from './matchmaking/routes';
import organization from './organization/routes';
import probes from './probes/routes';
import questions from './questions/routes';
import { scheduledQuestions } from './questions/scheduled';
import results from './results/routes';
import rooms from './rooms/routes';

export { GameRoom } from './game/GameRoom';
export { Matchmaker } from './matchmaking/Matchmaker';
export { Probe } from './probes/Probe';

const app = new Hono<{ Bindings: Env }>();

app.get(API_PATHS.health, health);

app.route('/', probes);
app.route('/', game);
app.route('/', matchmaking);
app.route('/', results);
app.route('/', organization);
app.route('/', questions);
app.route('/', rooms);

app.notFound(notFound);

app.onError(handleError);

export default Object.assign(app, {
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(scheduledQuestions(env));
  },
});
