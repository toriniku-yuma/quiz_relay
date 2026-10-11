import { eq } from 'drizzle-orm';
import type { Handler } from 'hono';
import type { AuthEnv } from '../auth/handlers.ts';
import { instances, matchResults } from '../db/schema.ts';
import { readInvestigation } from '../results/investigation.ts';
import { OrganizationError, organizationEnabled, validId } from './access.ts';
import { bulkSanctions } from './bulk.ts';
import { organizationDatabase } from './database.ts';
import { moderationOverview, mutateSanction, personalModeration } from './moderation.ts';
import { moderationWorkflow } from './workflow.ts';

export const manageUsers: Handler<AuthEnv> = async (context) => {
  if (!organizationEnabled(context.env))
    throw new OrganizationError('ORGANIZATION_UNAVAILABLE', 503);
  const input: unknown = await context.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_SANCTION', 400);
  const value = input as Record<string, unknown>;
  const { db, close } = organizationDatabase(context.env);
  try {
    if (context.req.path.endsWith('/personal'))
      return context.json(await personalModeration(db, context.get('subject'), value));
    if (context.req.path.endsWith('/mutate')) {
      const results =
        value.action === 'bulk'
          ? await bulkSanctions(db, context.get('subject'), value)
          : [await mutateSanction(db, context.get('subject'), value)];
      for (const result of results) {
        const [scope] = await db
          .select()
          .from(instances)
          .where(eq(instances.id, result.instanceIds[0]));
        if (scope)
          await Promise.allSettled(
            result.instanceIds.map((id) =>
              context.env.MATCHMAKER.getByName(scope.organizationId).refreshWaiting(
                result.actorId,
                id,
              ),
            ),
          );
      }
      return context.json({ ok: true });
    }
    if (context.req.path.endsWith('/workflow')) {
      let evidence: typeof matchResults.$inferSelect.payload | undefined;
      if (value.action === 'report') {
        const rows = await db
          .select()
          .from(matchResults)
          .where(eq(matchResults.resultId, validId(value.resultId)));
        evidence = rows[0]?.payload;
      }
      return context.json(
        await moderationWorkflow(db, context.get('subject'), value, evidence),
      );
    }
    const result = await moderationOverview(db, context.get('subject'), value);
    if (context.req.path.endsWith('/history')) {
      if (!result.target) throw new OrganizationError('ACCOUNT_NOT_FOUND', 404);
      const [scope] = await db
        .select()
        .from(instances)
        .where(eq(instances.id, validId(value.instanceId)));
      const report = result.reports?.find(
        (candidateReport) => candidateReport.id === value.reportId,
      );
      if (!scope || (value.reportId && !report))
        throw new OrganizationError('REPORT_NOT_FOUND', 404);
      try {
        return context.json(
          await readInvestigation(
            db,
            scope.owner,
            result.target.actorId,
            report?.resultId ?? null,
            value,
          ),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          ['INVALID_SAMPLE', 'INVALID_PAGE', 'INVALID_SORT'].includes(error.message)
        )
          throw new OrganizationError(error.message, 400);
        throw error;
      }
    }
    return context.json(result);
  } finally {
    await close();
  }
};
