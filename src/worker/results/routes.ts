import { Hono } from 'hono';
import { API_PATHS } from '../../shared/api-paths.ts';
import { type AuthEnv, authenticate, sameOrigin } from '../auth/handlers.ts';
import { instanceContext } from '../organization/handlers.ts';
import { resultsOverview } from './handlers.ts';

const results = new Hono<AuthEnv>();
results.post(
  API_PATHS.results,
  sameOrigin,
  authenticate,
  instanceContext,
  resultsOverview,
);
export default results;
