import { eq } from 'drizzle-orm';
import { connectDatabase } from '../db/connection';
import { instances, matchResults } from '../db/schema';
import type { Env } from '../env';
import { organizationDatabase } from '../organization/database';
import { updateDifficultyInstance } from './daily';

// Deliberately disabled by default. This change does not install a Cron trigger or enable production writes.
export async function scheduledQuestions(env: Env, now = Date.now()) {
  if (env.QUESTION_DIFFICULTY_ENABLED !== 'true' || env.ORGANIZATION_ENABLED !== 'true')
    return;
  const binding = env.GAME_HYPERDRIVE;
  const address = binding?.connectionString ?? env.GAME_DATABASE_URL;
  if (!address) throw new Error('GAME_DATABASE_NOT_CONFIGURED');
  const organization = organizationDatabase(env);
  const reader = connectDatabase(address, env.DATABASE_CA_CERT, !!binding);
  try {
    for (const instance of await organization.db.select().from(instances)) {
      const records = await reader.db
        .select({ payload: matchResults.payload })
        .from(matchResults)
        .where(eq(matchResults.owner, instance.owner));
      await updateDifficultyInstance(organization.db, env.GAME_CONFIG_PROFILE, {
        organizationId: instance.organizationId,
        instanceId: instance.id,
        owner: instance.owner,
        records: records.map((record) => record.payload),
        now,
      });
    }
  } finally {
    await reader.close();
    await organization.close();
  }
}
