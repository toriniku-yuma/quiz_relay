import type { Handler } from 'hono';
import { API_PATHS } from '../../shared/api-paths.ts';
import type { SharedQuestionPage } from '../../shared/federation-questions.ts';
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
  let body: SharedQuestionPage | { code: 'QUESTION_SNAPSHOT_CHANGED' };
  try {
    body = await exportSharedQuestions(
      federationDatabase(context.env),
      delivery.issuer,
      delivery.body,
    );
  } catch (error) {
    if (
      !(error instanceof OrganizationError) ||
      error.code !== 'QUESTION_SNAPSHOT_CHANGED'
    )
      throw error;
    body = { code: 'QUESTION_SNAPSHOT_CHANGED' };
  }
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
  const result = await questionSharing(
    context.env,
    context.get('subject'),
    input as Record<string, unknown>,
  );
  if (
    'id' in result &&
    typeof result.id === 'string' &&
    (input as Record<string, unknown>).enabled === true
  ) {
    if (!context.env.ACCOUNT_ERASURE)
      throw new OrganizationError('ERASURE_UNAVAILABLE', 503);
    const response = await context.env.ACCOUNT_ERASURE.fetch(
      'https://account-erasure.internal/maintenance',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'federationQuestions', importId: result.id }),
      },
    );
    await response.arrayBuffer();
    if (!response.ok && response.status !== 503)
      throw new OrganizationError('QUESTION_SYNC_UNAVAILABLE', 503);
  }
  return context.json(result);
};
