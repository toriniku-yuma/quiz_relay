import canonicalize from 'canonicalize';
import { getTableColumns, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { QuestionInput } from '../../src/shared/questions.ts';
import { changeD1, type Database, rowBatchesD1 } from '../../src/worker/db/d1.ts';
import * as targetSchema from '../../src/worker/db/schema.ts';
import { resultTrials } from '../../src/worker/questions/difficulty-statistics.ts';
import { questionSearchText } from '../../src/worker/questions/search.ts';
import type { ResultRecord } from '../../src/worker/results/record.ts';
import * as sourceSchema from './schema.ts';

export type SourceTable = { name: string; rows: Record<string, unknown>[]; hash: string };
export function postgresCopy(tables: SourceTable[]) {
  const sourceTables = Object.fromEntries(
    Object.entries(sourceSchema).filter(([, table]) => is(table, PgTable)),
  ) as Record<string, PgTable>;
  const targets = Object.fromEntries(
    Object.entries(targetSchema).filter(([, table]) => is(table, SQLiteTable)),
  ) as Record<string, SQLiteTable>;
  const sourceNames = Object.keys(sourceTables);
  if (
    tables.length !== sourceNames.length ||
    new Set(tables.map((table) => table.name)).size !== sourceNames.length ||
    tables.some((table) => !sourceTables[table.name])
  )
    throw new Error('SOURCE_TABLES_MISMATCH');
  const pending = new Map(tables.map((table) => [table.name, table])),
    names = new Map(Object.entries(targets).map(([name, table]) => [table, name])),
    ordered: SourceTable[] = [];
  while (pending.size) {
    let progress = false;
    for (const [name, item] of pending) {
      if (name === 'instanceDeletions' && pending.size > 1) continue;
      const target = targets[name];
      if (!target) throw new Error('MISSING_D1_TABLE');
      if (
        getTableConfig(target).foreignKeys.some((key) => {
          const dependency = names.get(key.reference().foreignTable);
          return dependency !== name && dependency && pending.has(dependency);
        })
      )
        continue;
      const columns = getTableColumns(sourceTables[name]),
        rows = structuredClone(item.rows);
      for (const row of rows)
        for (const [key, column] of Object.entries(columns)) {
          if (row[key] === null || !column.columnType.startsWith('PgTimestamp')) continue;
          const value = String(row[key]),
            fraction = value.match(/(?:T|\s)\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1],
            instant = new Date(value).toISOString();
          row[key] =
            fraction && fraction.length > 3
              ? instant.replace(/\.\d{3}Z$/, `.${fraction}Z`)
              : instant;
        }
      if (name === 'questionSubmissions')
        for (const row of rows)
          row.searchText = questionSearchText(row.input as QuestionInput);
      if (name === 'accountWithdrawals')
        for (const row of rows) row.auditErasedAt = row.erasedAt;
      if (name === 'questionDifficulty')
        for (const row of rows) row.statisticsRevision = 0;
      ordered.push({ ...item, rows });
      pending.delete(name);
      progress = true;
    }
    if (!progress) throw new Error('CYCLIC_D1_DEPENDENCIES');
  }
  return { targets, ordered };
}
export async function installPostgresCopy(db: Database, tables: SourceTable[]) {
  const plan = postgresCopy(tables);
  const records = plan.ordered.find((table) => table.name === 'matchResults')?.rows ?? [];
  const trials = records.flatMap((row) => resultTrials(row.payload as ResultRecord));
  const backfills = (
    plan.ordered.find((table) => table.name === 'instances')?.rows ?? []
  ).map((row) => ({
    owner: String(row.owner),
    finishedAt: '',
    resultId: '',
    complete: true,
  }));
  await changeD1(db, async (writes) => {
    for (const table of plan.ordered)
      writes.push(...rowBatchesD1(plan.targets[table.name], table.rows));
    writes.push(
      ...rowBatchesD1(targetSchema.difficultyTrials, trials, 'ignore'),
      ...rowBatchesD1(targetSchema.difficultyBackfills, backfills),
    );
  });
  return plan;
}
function orderedRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => canonicalize(row) as string).sort();
}
export async function verifyPostgresCopy(
  db: Database,
  plan: ReturnType<typeof postgresCopy>,
) {
  let rows = 0;
  for (const table of plan.ordered) {
    const actual = await db.select().from(plan.targets[table.name]);
    if (canonicalize(orderedRows(actual)) !== canonicalize(orderedRows(table.rows)))
      throw new Error('COPY_MISMATCH');
    rows += actual.length;
  }
  const integrity = await db.$client.prepare('PRAGMA quick_check').all(),
    foreignKeys = await db.$client.prepare('PRAGMA foreign_key_check').all();
  if (
    integrity.results.some((row) => Object.values(row)[0] !== 'ok') ||
    foreignKeys.results.length
  )
    throw new Error('D1_INTEGRITY_FAILURE');
  return { tables: plan.ordered.length, rows, integrity: 'ok' };
}
