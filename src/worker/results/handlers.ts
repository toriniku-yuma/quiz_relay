import type { Handler } from 'hono';
import { resultsQuery } from '../../shared/results';
import type { AuthEnv } from '../auth/handlers';
import { connectDatabase } from '../db/connection';
import { organizationDatabase } from '../organization/database';
import { rankingExclusions } from '../organization/moderation';
import { currentProfileNames } from '../organization/profile';
import { readResults } from './read';

export const resultsOverview: Handler<AuthEnv> = async (context) => {
  let query: ReturnType<typeof resultsQuery>;
  try {
    const text = await context.req.text();
    query = resultsQuery(text ? JSON.parse(text) : {});
  } catch {
    return context.json({ code: 'INVALID_SETUP' }, 400);
  }
  const binding = context.env.GAME_HYPERDRIVE;
  const url = binding?.connectionString ?? context.env.GAME_DATABASE_URL;
  if (!url) return context.json({ code: 'RESULTS_UNAVAILABLE' }, 503);
  const { db, close } = connectDatabase(url, context.env.DATABASE_CA_CERT, !!binding);
  try {
    let excludedActors: string[] = [];
    if (context.get('instanceId')) {
      const organization = organizationDatabase(context.env);
      try {
        excludedActors = await rankingExclusions(
          organization.db,
          context.get('organizationId'),
          context.get('instanceId'),
        );
      } finally {
        await organization.close();
      }
    }
    const result = await readResults(
      db,
      context.get('instanceOwner'),
      context.get('actorId'),
      excludedActors,
      query,
    );
    if (context.get('instanceId') && result.ranking.length) {
      const organization = organizationDatabase(context.env);
      try {
        const names = await currentProfileNames(
          organization.db,
          context.get('organizationId'),
          result.ranking.map((row) => row.actorId),
        );
        result.ranking = result.ranking.map((row) => ({
          ...row,
          name: names.get(row.actorId) ?? row.name,
        }));
      } finally {
        await organization.close();
      }
    }
    return context.json(result);
  } catch {
    return context.json({ code: 'RESULTS_UNAVAILABLE' }, 503);
  } finally {
    await close();
  }
};
