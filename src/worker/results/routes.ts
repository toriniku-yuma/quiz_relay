import { Hono } from 'hono';
import { API_PATHS } from '../../shared/api-paths';
import { type AuthEnv, authenticate, sameOrigin } from '../auth/handlers';
import { instanceContext } from '../organization/handlers';
import { resultsOverview } from './handlers';

const results = new Hono<AuthEnv>();
results.post(
  API_PATHS.results,
  sameOrigin,
  authenticate,
  instanceContext,
  resultsOverview,
);
export default results;
