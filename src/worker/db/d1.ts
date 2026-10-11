import { eq, getTableColumns, SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  getTableConfig,
  SQLiteAsyncDialect,
  type SQLiteTable,
} from 'drizzle-orm/sqlite-core';
import { databaseRevision } from './schema.ts';

export function connectD1(binding: D1Database) {
  return drizzle(binding);
}

export type Database = ReturnType<typeof connectD1>;
export type D1Write = SQL | { toSQL(): { sql: string; params: unknown[] } };
const dialect = new SQLiteAsyncDialect();

// Drizzle encodes JSON columns as strings. Bound documents must include that overhead.
export function rowBatchesD1<T extends SQLiteTable>(
  table: T,
  rows: T['$inferInsert'][],
  update: boolean | 'ignore' = false,
): SQL[] {
  const columns = getTableColumns(table);
  const batches: SQL[] = [];
  let pending: T['$inferInsert'][] = [],
    bytes = 2;
  for (const row of rows) {
    const encoded = Object.fromEntries(
      Object.entries(row)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          key,
          value === null ? null : columns[key].mapToDriverValue(value),
        ]),
    );
    const size = new TextEncoder().encode(JSON.stringify(encoded)).byteLength + 1;
    if (size > 1500000) throw new Error('D1_ROW_TOO_LARGE');
    if (pending.length && bytes + size > 1500000) {
      batches.push(rowsD1(table, pending, update));
      pending = [];
      bytes = 2;
    }
    pending.push(row);
    bytes += size;
  }
  if (pending.length) batches.push(rowsD1(table, pending, update));
  return batches;
}

// One bound JSON document keeps 500-row imports within D1's parameter limit.
export function rowsD1<T extends SQLiteTable>(
  table: T,
  rows: T['$inferInsert'][],
  update: boolean | 'ignore' = false,
): SQL {
  if (!rows.length) throw new Error('EMPTY_D1_ROWS');
  const columns = getTableColumns(table);
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (keys.some((key) => !columns[key])) throw new Error('UNKNOWN_D1_COLUMN');
  const encoded = rows.map((row) =>
    Object.fromEntries(
      keys.flatMap((key) => {
        const value = (row as Record<string, unknown>)[key];
        return value === undefined
          ? []
          : [[key, value === null ? null : columns[key].mapToDriverValue(value)]];
      }),
    ),
  );
  const selected = keys.map((key) => {
    const column = columns[key];
    const path = `$.${key}`;
    const fallback = column.default ?? null;
    const defaultValue =
      fallback instanceof SQL
        ? fallback
        : sql`${fallback === null ? null : column.mapToDriverValue(fallback)}`;
    return sql`case when json_type(value, ${path}) is null then ${defaultValue} else json_extract(value, ${path}) end`;
  });
  const config = getTableConfig(table);
  const primary = [
    ...Object.values(columns).filter((column) => column.primary),
    ...config.primaryKeys.flatMap((key) => key.columns),
  ];
  const primaryNames = [...new Set(primary.map((column) => column.name))];
  const changed = keys.filter((key) => !primaryNames.includes(columns[key].name));
  const conflict = primaryNames.length
    ? sql`(${sql.join(
        primaryNames.map((name) => sql.identifier(name)),
        sql`, `,
      )})`
    : sql``;
  const action =
    update === true && changed.length
      ? sql`do update set ${sql.join(
          changed.map(
            (key) =>
              sql`${sql.identifier(columns[key].name)} = excluded.${sql.identifier(columns[key].name)}`,
          ),
          sql`, `,
        )}`
      : sql`do nothing`;
  const onConflict = update ? sql`on conflict ${conflict} ${action}` : sql``;
  return sql`insert into ${table} (${sql.join(
    keys.map((key) => sql.identifier(columns[key].name)),
    sql`, `,
  )}) select ${sql.join(selected, sql`, `)} from json_each(${JSON.stringify(encoded)}) where 1 ${onConflict}`;
}

function stale(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('STALE_D1_SNAPSHOT') || stale(error.cause))
  );
}

function retryDelay(attempt: number) {
  // Competing plans should not retry in lockstep. Keep the existing three-attempt limit.
  return new Promise<void>((resolve) =>
    setTimeout(resolve, (50 + Math.random() * 50) * 2 ** attempt),
  );
}

export async function readD1<T>(db: Database, read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [before] = await db.select().from(databaseRevision);
    const value = await read();
    const [after] = await db.select().from(databaseRevision);
    if (before.revision === after.revision) return value;
    if (attempt < 2) await retryDelay(attempt);
  }
  throw new Error('D1_BUSY');
}

// Read and validate first, then commit explicit statements in one real D1 batch.
// ponytail: one revision per installation; partition only if measured write contention requires it.
export async function changeD1<T>(
  db: Database,
  plan: (writes: D1Write[]) => Promise<T>,
): Promise<T> {
  return (await changeD1Batch(db, plan)).value;
}

export async function changeD1Batch<T>(
  db: Database,
  plan: (writes: D1Write[]) => Promise<T>,
): Promise<{ value: T; rowsRead: number; rowsWritten: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [before] = await db.select().from(databaseRevision);
    const writes: D1Write[] = [];
    const value = await plan(writes);
    if (!writes.length) {
      const [after] = await db.select().from(databaseRevision);
      if (before.revision === after.revision)
        return { value, rowsRead: 0, rowsWritten: 0 };
      if (attempt < 2) await retryDelay(attempt);
      continue;
    }
    const queries = [
      db
        .update(databaseRevision)
        .set({ revision: before.revision + 1 })
        .where(eq(databaseRevision.id, 1)),
      ...writes,
    ].map((query) => {
      const compiled = 'toSQL' in query ? query.toSQL() : dialect.sqlToQuery(query);
      return db.$client.prepare(compiled.sql).bind(...compiled.params);
    });
    try {
      const saved = await db.$client.batch(queries);
      return saved.reduce(
        (usage, statement) => ({
          value,
          rowsRead: usage.rowsRead + statement.meta.rows_read,
          rowsWritten: usage.rowsWritten + statement.meta.rows_written,
        }),
        { value, rowsRead: 0, rowsWritten: 0 },
      );
    } catch (error) {
      if (!stale(error)) throw error;
      if (attempt < 2) await retryDelay(attempt);
    }
  }
  throw new Error('D1_BUSY');
}
