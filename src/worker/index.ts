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
  scheduled: async (_event: ScheduledController, env: Env, _ctx: ExecutionContext) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await env.MATCHMAKER.getByName('maintenance').runMaintenance();
        return;
      } catch (error) {
        const failure = error as { retryable?: boolean; overloaded?: boolean } | null;
        if (attempt || failure?.retryable !== true || failure.overloaded) throw error;
        // Platform errors can invalidate the stub. Retry once with a new stub;
        // committed jobs and leases remain in D1, and overlapping calls share a run.
        await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 500));
      }
    }
  },
});
