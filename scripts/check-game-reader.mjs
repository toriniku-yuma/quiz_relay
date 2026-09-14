import assert from 'node:assert/strict';
import { count, eq, sql } from 'drizzle-orm';
import { connectDatabase } from '../src/worker/db/connection.ts';
import {
  competitions,
  matchmakingSettings,
  probeRuns,
  questionAvailability,
  questionVersions,
  rulesetVersions,
} from '../src/worker/db/schema.ts';

if (!process.env.GAME_DATABASE_URL) throw new Error('GAME_DATABASE_NOT_CONFIGURED');
const { db, close } = connectDatabase(
  process.env.GAME_DATABASE_URL,
  process.env.DATABASE_CA_CERT,
);
const denied = (error) => (error.cause?.code ?? error.code) === '42501';
try {
  const [identity] = await db.execute(sql`select current_user as name`);
  assert.equal(identity.name, 'quiz_game_reader');
  const [rows] = await db.select({ count: count() }).from(questionVersions);
  assert.ok(rows.count >= 12);
  const owner = 'https://reader-test.invalid';
  await assert.rejects(
    db
      .update(rulesetVersions)
      .set({ version: 1 })
      .where(eq(rulesetVersions.owner, owner)),
    denied,
  );
  await assert.rejects(
    db.delete(questionVersions).where(eq(questionVersions.owner, owner)),
    denied,
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx
        .insert(questionAvailability)
        .values({ owner, questionId: 'never-inserted' });
      throw new Error('UNEXPECTED_WRITE_PERMISSION');
    }),
    denied,
  );
  await assert.rejects(
    db
      .update(matchmakingSettings)
      .set({ profile: 'never-updated' })
      .where(eq(matchmakingSettings.owner, owner)),
    denied,
  );
  await assert.rejects(db.select().from(probeRuns).limit(0), denied);
  await db.select().from(competitions).limit(1);
  console.log('PASS: reader TLS identity and SELECT; writes and probe access denied');
} catch {
  console.error('GAME_READER_CHECK_FAILED');
  process.exitCode = 1;
} finally {
  await close();
}
