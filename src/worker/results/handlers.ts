import type { Handler } from 'hono';
import type { AuthEnv } from '../auth/handlers';
import { connectDatabase } from '../db/connection';
import { readResults } from './read';

export const resultsOverview: Handler<AuthEnv> = async (c) => {
  const binding = c.env.GAME_HYPERDRIVE;
  const url = binding?.connectionString ?? c.env.GAME_DATABASE_URL;
  if (!url) return c.json({ code: 'RESULTS_UNAVAILABLE' }, 503);
  const { db, close } = connectDatabase(url, c.env.DATABASE_CA_CERT, !!binding);
  try {
    return c.json(await readResults(db, c.get('instanceOwner'), c.get('actorId')));
  } catch {
    return c.json({ code: 'RESULTS_UNAVAILABLE' }, 503);
  } finally {
    await close();
  }
};
