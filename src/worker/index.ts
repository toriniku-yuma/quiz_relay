import { Hono } from 'hono';
import { API_PATHS } from '../shared/api-paths';
import type { Env } from './env';
import { handleError, health, notFound } from './http/handlers';
import probes from './probes/routes';

export { Probe } from './probes/Probe';

const app = new Hono<{ Bindings: Env }>();

app.get(API_PATHS.health, health);

app.route('/', probes);

app.notFound(notFound);

app.onError(handleError);

export default app;
