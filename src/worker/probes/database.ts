import { eq, inArray, sql } from 'drizzle-orm';
import { changeD1, connectD1 } from '../db/d1.ts';
import { probeRuns } from '../db/schema.ts';

export async function probeDatabase(binding: D1Database) {
  const db = connectD1(binding),
    id = crypto.randomUUID(),
    rolledBackId = crypto.randomUUID();
  try {
    await changeD1(db, async (writes) => {
      writes.push(db.insert(probeRuns).values({ id }));
    });
    let rolledBack = false;
    try {
      await changeD1(db, async (writes) => {
        writes.push(
          db.insert(probeRuns).values({ id: rolledBackId }),
          sql`select raise_invalid_probe_statement()`,
        );
      });
    } catch {
      rolledBack = true;
    }
    const committed = await db.select().from(probeRuns).where(eq(probeRuns.id, id)),
      reverted = await db.select().from(probeRuns).where(eq(probeRuns.id, rolledBackId));
    if (!rolledBack || committed.length !== 1 || reverted.length !== 0)
      throw new Error('D1_BATCH_PERSISTENCE');
    return {
      committed: true,
      rolledBack: true,
      preparedStatements: true,
      database: 'd1' as const,
    };
  } finally {
    await changeD1(db, async (writes) => {
      writes.push(db.delete(probeRuns).where(inArray(probeRuns.id, [id, rolledBackId])));
    });
  }
}
