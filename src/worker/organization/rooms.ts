import { and, eq, sql } from 'drizzle-orm';
import type { QuestionSelection } from '../../shared/questions.ts';
import { changeD1 } from '../db/d1.ts';
import { instanceDeletions, instanceRooms, instances } from '../db/schema.ts';
import type { Env } from '../env.ts';
import type { InstanceScope } from '../matchmaking/Matchmaker.ts';
import { privateSelectionSQL } from '../results/privacy.ts';
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
    return await changeD1(db, async (writes) => {
      const tx = db;
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
      const [registered] = await tx
        .select()
        .from(instanceRooms)
        .where(eq(instanceRooms.roomId, roomId));
      if (registered && registered.instanceId !== scope.id)
        throw new OrganizationError('INSTANCE_ROOM_CONFLICT', 409);
      writes.push(
        tx
          .insert(instanceRooms)
          .values({ roomId, instanceId: scope.id })
          .onConflictDoNothing(),
      );
      if (selection) {
        const [row] = await tx.all<{ selection: string }>(
          sql`select ${privateSelectionSQL(sql`${scope.owner}`, sql`${JSON.stringify(selection)}`)} as selection`,
        );
        return JSON.parse(row.selection) as QuestionSelection;
      }
    });
  } finally {
    await close();
  }
}
