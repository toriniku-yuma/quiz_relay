import type { Handler } from 'hono';
import type { AuthEnv } from '../auth/handlers';
import { connectDatabase } from '../db/connection';
import { organizationDatabase } from '../organization/database';
import { rankingExclusions } from '../organization/moderation';
import { currentProfileNames } from '../organization/profile';
import { readResults } from './read';

export const resultsOverview: Handler<AuthEnv> = async (c) => {
  const binding = c.env.GAME_HYPERDRIVE;
  const url = binding?.connectionString ?? c.env.GAME_DATABASE_URL;
  if (!url) return c.json({ code: 'RESULTS_UNAVAILABLE' }, 503);
  const { db, close } = connectDatabase(url, c.env.DATABASE_CA_CERT, !!binding);
  try {
    let excludedActors: string[] = [];
    if (c.get('instanceId')) {
      const organization = organizationDatabase(c.env);
      try {
        excludedActors = await rankingExclusions(
          organization.db,
          c.get('organizationId'),
          c.get('instanceId'),
        );
      } finally {
        await organization.close();
      }
    }
    const result = await readResults(
      db,
      c.get('instanceOwner'),
      c.get('actorId'),
      excludedActors,
    );
    if (c.get('instanceId') && result.ranking.length) {
      const organization = organizationDatabase(c.env);
      try {
        const names = await currentProfileNames(
          organization.db,
          c.get('organizationId'),
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
    return c.json(result);
  } catch {
    return c.json({ code: 'RESULTS_UNAVAILABLE' }, 503);
  } finally {
    await close();
  }
};
