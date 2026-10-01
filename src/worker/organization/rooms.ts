import { and, eq, sql } from 'drizzle-orm';
import type { QuestionSelection } from '../../shared/questions.ts';
import { instanceDeletions, instanceRooms, instances } from '../db/schema.ts';
import type { Env } from '../env.ts';
import type { InstanceScope } from '../matchmaking/Matchmaker.ts';
import { OrganizationError } from './access.ts';
import { organizationDatabase } from './database.ts';

export async function registerInstanceRoom(
  env: Env,
  scope: InstanceScope,
  roomId: string,
  existing: boolean,
  selection?: QuestionSelection,
) {
  const { db, close } = organizationDatabase(env);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${scope.id}`},0))`,
      );
      const [instance] = await tx
        .select()
        .from(instances)
        .where(and(eq(instances.id, scope.id), eq(instances.owner, scope.owner)));
      if (!instance || (!existing && instance.state === 'archived'))
        throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
      if (
        (
          await tx
            .select()
            .from(instanceDeletions)
            .where(eq(instanceDeletions.instanceId, scope.id))
        ).length
      )
        throw new OrganizationError('INSTANCE_DELETING', 409);
      await tx
        .insert(instanceRooms)
        .values({ roomId, instanceId: scope.id })
        .onConflictDoNothing();
      if (selection) {
        const [row] = await tx.execute<{ selection: QuestionSelection }>(
          sql`select quiz_game.private_selection(${scope.owner},${JSON.stringify(selection)}::jsonb) as selection`,
        );
        return row.selection;
      }
    });
  } finally {
    await close();
  }
}
