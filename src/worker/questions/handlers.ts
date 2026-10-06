import { eq } from 'drizzle-orm';
import type { Handler } from 'hono';
import type { AuthEnv } from '../auth/handlers';
import { connectDatabase } from '../db/connection';
import { matchResults } from '../db/schema';
import { organizationDatabase } from '../organization/database';
import { QuestionError, questionMutation, questionOverview } from './database';
import { verifiedReportedQuestion } from './reports';

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
        async (owner) => {
          const binding = context.env.GAME_HYPERDRIVE,
            address = binding?.connectionString ?? context.env.GAME_DATABASE_URL;
          if (!address) throw new QuestionError('RESULTS_UNAVAILABLE');
          const reader = connectDatabase(
            address,
            context.env.DATABASE_CA_CERT,
            !!binding,
          );
          try {
            return (
              await reader.db
                .select({ payload: matchResults.payload })
                .from(matchResults)
                .where(eq(matchResults.owner, owner))
            ).map((result) => result.payload);
          } finally {
            await reader.close();
          }
        },
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
