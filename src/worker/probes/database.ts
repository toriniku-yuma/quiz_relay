import { eq, inArray } from 'drizzle-orm';
import { connectDatabase } from '../db/connection.ts';
import { probeRuns } from '../db/schema.ts';

export async function probeDatabase(url: string, ca?: string, viaHyperdrive = false) {
  const { db, close } = connectDatabase(url, ca, viaHyperdrive);
  const id = crypto.randomUUID();
  const rolledBackId = crypto.randomUUID();
  const rollback = new Error('probe rollback');
  try {
    await db.transaction(async (tx) => {
      await tx.insert(probeRuns).values({ id });
      const rows = await tx
        .select({ id: probeRuns.id })
        .from(probeRuns)
        .where(eq(probeRuns.id, id));
      if (rows.length !== 1) throw new Error('transaction visibility');
    });
    try {
      await db.transaction(async (tx) => {
        await tx.insert(probeRuns).values({ id: rolledBackId });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    const committed = await db
      .select({ id: probeRuns.id })
      .from(probeRuns)
      .where(eq(probeRuns.id, id));
    const reverted = await db
      .select({ id: probeRuns.id })
      .from(probeRuns)
      .where(eq(probeRuns.id, rolledBackId));
    if (committed.length !== 1 || reverted.length !== 0)
      throw new Error('transaction persistence');
    return {
      committed: true,
      rolledBack: true,
      preparedStatements: false,
      tls: viaHyperdrive ? 'hyperdrive-managed' : 'verify-full',
    };
  } finally {
    try {
      await db.delete(probeRuns).where(inArray(probeRuns.id, [id, rolledBackId]));
    } finally {
      await close();
    }
  }
}
