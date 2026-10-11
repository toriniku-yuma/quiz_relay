import type { Handler } from 'hono';
import { API_PATHS } from '../../shared/api-paths.ts';
import type { AuthEnv } from '../auth/handlers.ts';
import { OrganizationError } from '../organization/access.ts';
import { questionSharing } from './question-management.ts';
import { exportSharedQuestions } from './question-source.ts';
import { federationDatabase, receiveDelivery, signedDelivery } from './transport.ts';

export const sharedQuestionSync: Handler<AuthEnv> = async (context) => {
  const delivery = await receiveDelivery(
    context.req.raw,
    context.env,
    'questions.request',
  );
  const body = await exportSharedQuestions(
    federationDatabase(context.env),
    delivery.issuer,
    delivery.body,
  );
  return context.json({
    message: await signedDelivery(
      context.env,
      delivery.issuer,
      API_PATHS.federationQuestionSync,
      'questions.response',
      body,
      { replyTo: delivery.nonce },
    ),
  });
};
export const sharedQuestionManagement: Handler<AuthEnv> = async (context) => {
  const input: unknown = await context.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_QUESTION_SHARING', 400);
  return context.json(
    await questionSharing(
      context.env,
      context.get('subject'),
      input as Record<string, unknown>,
    ),
  );
};
