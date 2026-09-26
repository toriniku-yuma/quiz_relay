import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_PATHS } from '../../shared/api-paths';
import { type AuthEnv, authenticate, sameOrigin } from '../auth/handlers';
import { questionsHandler } from './handlers';

const questions = new Hono<AuthEnv>();
questions.use('/api/questions/*', sameOrigin);
questions.use(
  '/api/questions/*',
  bodyLimit({
    maxSize: 2010000,
    onError: (c) => c.json({ code: 'IMPORT_TOO_LARGE' }, 413),
  }),
);
questions.use('/api/questions/*', authenticate);
questions.post(API_PATHS.questions, questionsHandler);
export default questions;
