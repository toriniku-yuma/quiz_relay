import postgres from 'postgres';

export async function probeDatabase(url: string, ca?: string, viaHyperdrive = false) {
  // Hyperdrive handles origin TLS; its trusted binding connection is internal.
  const sql = postgres(url, {
    prepare: false,
    ssl: viaHyperdrive ? false : ca ? { ca, rejectUnauthorized: true } : 'verify-full',
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
  });

  const id = crypto.randomUUID();
  const rolledBackId = crypto.randomUUID();
  const rollback = new Error('probe rollback');

  try {
    await sql.begin(async (tx) => {
      await tx`insert into quiz_probe.runs (id) values (${id})`;
      const rows = await tx`select id from quiz_probe.runs where id = ${id}`;
      if (rows.length !== 1) throw new Error('transaction visibility');
    });

    try {
      await sql.begin(async (tx) => {
        await tx`insert into quiz_probe.runs (id) values (${rolledBackId})`;
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }

    const committed = await sql`select id from quiz_probe.runs where id = ${id}`;
    const reverted = await sql`select id from quiz_probe.runs where id = ${rolledBackId}`;
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
      await sql`delete from quiz_probe.runs where id in (${id}, ${rolledBackId})`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}
