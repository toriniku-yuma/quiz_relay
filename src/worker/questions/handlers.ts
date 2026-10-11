import type { Handler } from 'hono';
import type { AuthEnv } from '../auth/handlers.ts';
import { organizationDatabase } from '../organization/database.ts';
import { QuestionError, questionMutation, questionOverview } from './database.ts';
import { verifiedReportedQuestion } from './reports.ts';

export const questionsHandler: Handler<AuthEnv> = async (context) => {
  const { db, close } = organizationDatabase(context.env);
  try {
    const input: unknown = await context.req.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new QuestionError('INVALID_OPERATION');
    const body = input as Record<string, unknown>;
    const instanceId = context.req.query('instance') ?? '';
    if (body.operation === 'overview') {
      const overview = await questionOverview(
        db,
        context.get('subject'),
        instanceId,
        body.list,
        body.view,
      );
      return context.json(overview);
    }
    return context.json(
      await questionMutation(
        db,
        context.get('subject'),
        instanceId,
        body,
        context.env.GAME_CONFIG_PROFILE,
        body.operation === 'report'
          ? await verifiedReportedQuestion(
              context.env,
              context.get('subject'),
              instanceId,
              body.resultId,
              body.questionId,
            )
          : undefined,
        context.get('displayName'),
      ),
    );
  } catch (error) {
    if (error instanceof QuestionError)
      return context.json({ code: error.code, issues: error.issues }, error.status);
    throw error;
  } finally {
    await close();
  }
};
