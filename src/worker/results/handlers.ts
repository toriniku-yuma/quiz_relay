import type { Handler } from 'hono';
import { resultsQuery } from '../../shared/results.ts';
import type { AuthEnv } from '../auth/handlers.ts';
import { connectD1 } from '../db/d1.ts';
import { organizationDatabase } from '../organization/database.ts';
import { rankingExclusions } from '../organization/moderation.ts';
import { currentProfileNames } from '../organization/profile.ts';
import { readResults } from './read.ts';

export const resultsOverview: Handler<AuthEnv> = async (context) => {
  let query: ReturnType<typeof resultsQuery>;
  try {
    const text = await context.req.text();
    query = resultsQuery(text ? JSON.parse(text) : {});
  } catch {
    return context.json({ code: 'INVALID_SETUP' }, 400);
  }
  if (!context.env.GAME_D1) return context.json({ code: 'RESULTS_UNAVAILABLE' }, 503);
  const db = connectD1(context.env.GAME_D1);
  const organization = organizationDatabase(context.env);
  try {
    const excludedActors = await rankingExclusions(
      organization.db,
      context.get('organizationId'),
      context.get('instanceId'),
    );
    const result = await readResults(
      db,
      context.get('instanceOwner'),
      context.get('actorId'),
      excludedActors,
      query,
    );
    const names = await currentProfileNames(
      organization.db,
      context.get('organizationId'),
      result.ranking.map((row) => row.actorId),
    );
    result.ranking = result.ranking.map((row) => ({
      ...row,
      name: names.get(row.actorId) ?? row.name,
    }));
    return context.json(result);
  } catch {
    return context.json({ code: 'RESULTS_UNAVAILABLE' }, 503);
  } finally {
    await organization.close();
  }
};
