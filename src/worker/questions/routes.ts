import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_PATHS } from '../../shared/api-paths.ts';
import { type AuthEnv, authenticate, sameOrigin } from '../auth/handlers.ts';
import { questionsHandler } from './handlers.ts';

const questions = new Hono<AuthEnv>();
questions.use('/api/questions/*', sameOrigin);
questions.use(
  '/api/questions/*',
  bodyLimit({
    // The 2 MB JSON file is escaped inside a JSON request; category mapping adds overhead.
    maxSize: 5000000,
    onError: (context) => context.json({ code: 'IMPORT_TOO_LARGE' }, 413),
  }),
);
questions.use('/api/questions/*', authenticate);
questions.post(API_PATHS.questions, questionsHandler);
export default questions;
