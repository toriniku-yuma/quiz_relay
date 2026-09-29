import { eq } from 'drizzle-orm';
import type { Handler } from 'hono';
import type { AuthEnv } from '../auth/handlers';
import { connectDatabase } from '../db/connection';
import { matchResults } from '../db/schema';
import { organizationDatabase } from '../organization/database';
import { QuestionError, questionMutation, questionOverview } from './database';
import { verifiedReportedQuestion } from './reports';

export const questionsHandler: Handler<AuthEnv> = async (c) => {
  const { db, close } = organizationDatabase(c.env);
  try {
    const input: unknown = await c.req.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new QuestionError('INVALID_OPERATION');
    const body = input as Record<string, unknown>;
    const instanceId = c.req.query('instance') ?? '';
    if (body.operation === 'overview') {
      const overview = await questionOverview(
        db,
        c.get('subject'),
        instanceId,
        body.list,
        body.view,
        async (owner) => {
          const binding = c.env.GAME_HYPERDRIVE,
            address = binding?.connectionString ?? c.env.GAME_DATABASE_URL;
          if (!address) throw new QuestionError('RESULTS_UNAVAILABLE');
          const reader = connectDatabase(address, c.env.DATABASE_CA_CERT, !!binding);
          try {
            return (
              await reader.db
                .select({ payload: matchResults.payload })
                .from(matchResults)
                .where(eq(matchResults.owner, owner))
            ).map((r) => r.payload);
          } finally {
            await reader.close();
          }
        },
      );
      return c.json(overview);
    }
    return c.json(
      await questionMutation(
        db,
        c.get('subject'),
        instanceId,
        body,
        c.env.GAME_CONFIG_PROFILE,
        body.operation === 'report'
          ? await verifiedReportedQuestion(
              c.env,
              c.get('subject'),
              instanceId,
              body.resultId,
              body.questionId,
            )
          : undefined,
        c.get('displayName'),
      ),
    );
  } catch (error) {
    if (error instanceof QuestionError)
      return c.json({ code: error.code, issues: error.issues }, error.status);
    throw error;
  } finally {
    await close();
  }
};
