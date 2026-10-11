import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { connectD1 } from '../src/worker/db/d1';
import { matchResults, resultOutbox, resultPlayers } from '../src/worker/db/schema';
import { commitD1Result } from '../src/worker/results/database';
import { resultFixture } from './fixtures/result';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
beforeAll(() => applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS));

it('D1上で結果・参加者・配送原本をまとめて保存し、再送で二重加算しない', async () => {
  const { record } = resultFixture();
  const saved = await commitD1Result(runtime.GAME_D1, record);
  const replay = await commitD1Result(runtime.GAME_D1, {
    ...record,
    players: record.players,
  });
  expect(saved.rowsWritten).toBeGreaterThanOrEqual(record.players.length + 2);
  expect(replay.rowsWritten).toBe(0);
  const results = await db
    .select()
    .from(matchResults)
    .where(eq(matchResults.resultId, record.result.id));
  const players = await db
    .select()
    .from(resultPlayers)
    .where(eq(resultPlayers.resultId, record.result.id));
  const outbox = await db
    .select()
    .from(resultOutbox)
    .where(eq(resultOutbox.resultId, record.result.id));
  expect(results).toHaveLength(1);
  expect(players).toHaveLength(record.players.length);
  expect(outbox[0].payload).toEqual(record);
  expect(outbox[0].payloadHash).toBe(results[0].payloadHash);
});

it('同じ結果IDの別内容を拒否し、追加の参加者や配送原本を残さない', async () => {
  const { record } = resultFixture();
  await commitD1Result(runtime.GAME_D1, record);
  const changed = structuredClone(record);
  changed.players.push({ ...changed.players[0], id: 'unexpected' });
  await expect(commitD1Result(runtime.GAME_D1, changed)).rejects.toThrow(
    'RESULT_CONFLICT',
  );
  const players = await db
    .select()
    .from(resultPlayers)
    .where(eq(resultPlayers.resultId, record.result.id));
  expect(players.map((player) => player.actorId).sort()).toEqual(
    record.players.map((player) => player.id).sort(),
  );
});

it('同じ開催元・試合を別結果IDで保存する競合も拒否する', async () => {
  const { record } = resultFixture();
  const changed = structuredClone(record);
  changed.result.id = crypto.randomUUID();
  const outcomes = await Promise.allSettled([
    commitD1Result(runtime.GAME_D1, record),
    commitD1Result(runtime.GAME_D1, changed),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(
    await db.select().from(matchResults).where(eq(matchResults.matchId, record.matchId)),
  ).toHaveLength(1);
});

it('途中の参加者保存に失敗したら、結果と配送原本も取り消す', async () => {
  const { record } = resultFixture();
  record.players[0].ratingDelta = 999;
  await expect(commitD1Result(runtime.GAME_D1, record)).rejects.toThrow();
  expect(
    await db
      .select()
      .from(matchResults)
      .where(eq(matchResults.resultId, record.result.id)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(resultOutbox)
      .where(eq(resultOutbox.resultId, record.result.id)),
  ).toHaveLength(0);
});

it('結果原本の直接更新・削除と、原本にいない参加者の追加を拒否する', async () => {
  const { record } = resultFixture();
  await commitD1Result(runtime.GAME_D1, record);
  await expect(
    runtime.GAME_D1.prepare(
      'UPDATE quiz_game_match_results SET owner = ? WHERE result_id = ?',
    )
      .bind('changed', record.result.id)
      .run(),
  ).rejects.toThrow('IMMUTABLE_RESULT');
  await expect(
    runtime.GAME_D1.prepare('DELETE FROM quiz_game_result_outbox WHERE result_id = ?')
      .bind(record.result.id)
      .run(),
  ).rejects.toThrow('IMMUTABLE_OUTBOX');
  await expect(
    runtime.GAME_D1.prepare(
      'INSERT INTO quiz_game_result_players (result_id, actor_id, name, rating_delta) VALUES (?, ?, ?, ?)',
    )
      .bind(record.result.id, 'other', 'Other', 20)
      .run(),
  ).rejects.toThrow('INVALID_RESULT_PLAYER');
  expect(
    (
      await db
        .select()
        .from(matchResults)
        .where(eq(matchResults.resultId, record.result.id))
    )[0].owner,
  ).toBe(record.owner);
  expect(
    await db
      .select()
      .from(resultOutbox)
      .where(eq(resultOutbox.resultId, record.result.id)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(resultPlayers)
      .where(eq(resultPlayers.resultId, record.result.id)),
  ).toHaveLength(record.players.length);
});
