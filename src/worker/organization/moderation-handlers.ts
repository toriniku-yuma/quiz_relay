import { eq } from 'drizzle-orm';
import type { Handler } from 'hono';
import type { AuthEnv } from '../auth/handlers';
import { connectDatabase } from '../db/connection';
import { instances, matchResults } from '../db/schema';
import { readInvestigation } from '../results/investigation';
import { OrganizationError, organizationEnabled, validId } from './access';
import { bulkSanctions } from './bulk';
import { organizationDatabase } from './database';
import { moderationOverview, mutateSanction, personalModeration } from './moderation';
import { moderationWorkflow } from './workflow';

export const manageUsers: Handler<AuthEnv> = async (c) => {
  if (!organizationEnabled(c.env))
    throw new OrganizationError('ORGANIZATION_UNAVAILABLE', 503);
  const input: unknown = await c.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_SANCTION', 400);
  const value = input as Record<string, unknown>;
  const { db, close } = organizationDatabase(c.env);
  try {
    if (c.req.path.endsWith('/personal'))
      return c.json(await personalModeration(db, c.get('subject'), value));
    if (c.req.path.endsWith('/mutate')) {
      const results =
        value.action === 'bulk'
          ? await bulkSanctions(db, c.get('subject'), value)
          : [await mutateSanction(db, c.get('subject'), value)];
      for (const result of results) {
        const [scope] = await db
          .select()
          .from(instances)
          .where(eq(instances.id, result.instanceIds[0]));
        if (scope)
          await Promise.allSettled(
            result.instanceIds.map((id) =>
              c.env.MATCHMAKER.getByName(scope.organizationId).refreshWaiting(
                result.actorId,
                id,
              ),
            ),
          );
      }
      return c.json({ ok: true });
    }
    if (c.req.path.endsWith('/workflow')) {
      let evidence: typeof matchResults.$inferSelect.payload | undefined;
      if (value.action === 'report') {
        const binding = c.env.GAME_HYPERDRIVE,
          url = binding?.connectionString ?? c.env.GAME_DATABASE_URL;
        if (!url) throw new OrganizationError('RESULTS_UNAVAILABLE', 503);
        const reader = connectDatabase(url, c.env.DATABASE_CA_CERT, !!binding);
        try {
          const rows = await reader.db
            .select()
            .from(matchResults)
            .where(eq(matchResults.resultId, validId(value.resultId)));
          evidence = rows[0]?.payload;
        } finally {
          await reader.close();
        }
      }
      return c.json(await moderationWorkflow(db, c.get('subject'), value, evidence));
    }
    const result = await moderationOverview(db, c.get('subject'), value);
    if (c.req.path.endsWith('/history')) {
      if (!result.target) throw new OrganizationError('ACCOUNT_NOT_FOUND', 404);
      const [scope] = await db
        .select()
        .from(instances)
        .where(eq(instances.id, validId(value.instanceId)));
      const report = result.reports?.find((r) => r.id === value.reportId);
      if (!scope || (value.reportId && !report))
        throw new OrganizationError('REPORT_NOT_FOUND', 404);
      const binding = c.env.GAME_HYPERDRIVE,
        url = binding?.connectionString ?? c.env.GAME_DATABASE_URL;
      if (!url) throw new OrganizationError('RESULTS_UNAVAILABLE', 503);
      const reader = connectDatabase(url, c.env.DATABASE_CA_CERT, !!binding);
      try {
        return c.json(
          await readInvestigation(
            reader.db,
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
      } finally {
        await reader.close();
      }
    }
    return c.json(result);
  } finally {
    await close();
  }
};
