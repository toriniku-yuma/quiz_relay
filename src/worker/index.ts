import { Hono } from 'hono';
import { API_PATHS } from '../shared/api-paths.ts';
import type { Env } from './env.ts';
import federation from './federation/routes.ts';
import game from './game/routes.ts';
import { handleError, health, notFound } from './http/handlers.ts';
import matchmaking from './matchmaking/routes.ts';
import organization from './organization/routes.ts';
import probes from './probes/routes.ts';
import questions from './questions/routes.ts';
import results from './results/routes.ts';
import rooms from './rooms/routes.ts';
import { scheduledD1 } from './scheduled.ts';

export { GameRoom } from './game/GameRoom.ts';
export { Matchmaker } from './matchmaking/Matchmaker.ts';
export { Probe } from './probes/Probe.ts';

const app = new Hono<{ Bindings: Env }>();

app.get(API_PATHS.health, health);

app.route('/', probes);
app.route('/', game);
app.route('/', matchmaking);
app.route('/', results);
app.route('/', organization);
app.route('/', questions);
app.route('/', rooms);
app.route('/', federation);

app.notFound(notFound);

app.onError(handleError);

export default Object.assign(app, {
  scheduled: async (event: ScheduledController, env: Env, _ctx: ExecutionContext) => {
    if (!['0 * * * *', '0 19 * * *'].includes(event.cron))
      throw new Error('UNKNOWN_SCHEDULE');
    await scheduledD1(
      env,
      // A retry carries the original scheduled time; due jobs use the current clock.
      Date.now(),
      event.cron === '0 19 * * *' ? 'daily' : 'hourly',
    );
  },
});
