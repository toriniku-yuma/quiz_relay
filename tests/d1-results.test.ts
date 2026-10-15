import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { connectD1 } from '../src/worker/db/d1';
import { matches, resultOutbox, resultPlayers } from '../src/worker/db/schema';
import { commitFixtureResult } from './fixtures/match';
import { resultFixture } from './fixtures/result';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
beforeAll(() => applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS));

it('D1上で結果・参加者・配送原本をまとめて保存し、再送で二重加算しない', async () => {
  const { record } = resultFixture();
  const saved = await commitFixtureResult(runtime.GAME_D1, record);
  const replay = await commitFixtureResult(runtime.GAME_D1, {
    ...record,
    players: record.players,
  });
  expect(saved.rowsWritten).toBeGreaterThanOrEqual(record.players.length + 2);
  expect(replay.rowsWritten).toBe(0);
  const results = await db
    .select()
    .from(matches)
    .where(eq(matches.matchId, record.matchId));
  const players = await db
    .select()
    .from(resultPlayers)
    .where(eq(resultPlayers.matchId, record.matchId));
  const outbox = await db
    .select()
    .from(resultOutbox)
    .where(eq(resultOutbox.matchId, record.matchId));
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    matchId: record.matchId,
    status: 'confirmed',
    startedAt: new Date(record.startedAt).toISOString(),
    finishedAt: new Date(record.result.finishedAt).toISOString(),
  });
  expect(players).toHaveLength(record.players.length);
  expect(outbox[0].payload).toEqual(record);
  expect(outbox[0].payloadHash).toBe(results[0].payloadHash);
});

it('同じ試合IDの別内容を拒否し、追加の参加者や配送原本を残さない', async () => {
  const { record } = resultFixture();
  await commitFixtureResult(runtime.GAME_D1, record);
  const changed = structuredClone(record);
  changed.players.push({ ...changed.players[0], id: 'unexpected' });
  await expect(commitFixtureResult(runtime.GAME_D1, changed)).rejects.toThrow(
    'RESULT_CONFLICT',
  );
  const players = await db
    .select()
    .from(resultPlayers)
    .where(eq(resultPlayers.matchId, record.matchId));
  expect(players.map((player) => player.actorId).sort()).toEqual(
    record.players.map((player) => player.id).sort(),
  );
  const [stored] = await db
    .select()
    .from(matches)
    .where(eq(matches.matchId, record.matchId));
  expect(stored.status).toBe('conflict');
  expect(stored.payload).toEqual(record);
  await expect(commitFixtureResult(runtime.GAME_D1, record)).rejects.toThrow(
    'RESULT_CONFLICT',
  );
});

it('同じ試合へ異なる結果を同時送信した場合は一方だけ保存する', async () => {
  const { record } = resultFixture();
  const changed = structuredClone(record);
  changed.result.winnerId = 'b';
  const outcomes = await Promise.allSettled([
    commitFixtureResult(runtime.GAME_D1, record),
    commitFixtureResult(runtime.GAME_D1, changed),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(
    await db.select().from(matches).where(eq(matches.matchId, record.matchId)),
  ).toHaveLength(1);
});

it('途中の参加者保存に失敗したら、結果と配送原本も取り消す', async () => {
  const { record } = resultFixture();
  record.players[0].ratingDelta = 999;
  await expect(commitFixtureResult(runtime.GAME_D1, record)).rejects.toThrow();
  expect(
    await db.select().from(matches).where(eq(matches.matchId, record.matchId)),
  ).toMatchObject([{ status: 'running', payload: { result: null } }]);
  expect(
    await db.select().from(resultOutbox).where(eq(resultOutbox.matchId, record.matchId)),
  ).toHaveLength(0);
});

it('結果原本の直接更新・削除と、原本にいない参加者の追加を拒否する', async () => {
  const { record } = resultFixture();
  await commitFixtureResult(runtime.GAME_D1, record);
  await expect(
    runtime.GAME_D1.prepare('UPDATE quiz_game_matches SET owner = ? WHERE match_id = ?')
      .bind('changed', record.matchId)
      .run(),
  ).rejects.toThrow('IMMUTABLE_RESULT');
  await expect(
    runtime.GAME_D1.prepare('DELETE FROM quiz_game_result_outbox WHERE match_id = ?')
      .bind(record.matchId)
      .run(),
  ).rejects.toThrow('IMMUTABLE_OUTBOX');
  await expect(
    runtime.GAME_D1.prepare(
      'INSERT INTO quiz_game_result_players (match_id, actor_id, name, rating_delta) VALUES (?, ?, ?, ?)',
    )
      .bind(record.matchId, 'other', 'Other', 20)
      .run(),
  ).rejects.toThrow('INVALID_RESULT_PLAYER');
  expect(
    (await db.select().from(matches).where(eq(matches.matchId, record.matchId)))[0].owner,
  ).toBe(record.owner);
  expect(
    await db.select().from(resultOutbox).where(eq(resultOutbox.matchId, record.matchId)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(resultPlayers)
      .where(eq(resultPlayers.matchId, record.matchId)),
  ).toHaveLength(record.players.length);
});
