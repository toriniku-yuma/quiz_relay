import canonicalize from 'canonicalize';
import { eq, sql } from 'drizzle-orm';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, changeD1Batch, connectD1, type Database } from '../db/d1.ts';
import {
  matches,
  resultOutbox,
  resultPlayers,
  resultPrivacyChanges,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { planResultDeliveries } from '../federation/results.ts';
import { appendResultTrials } from '../questions/difficulty-statistics.ts';
import { ResultConflict } from './error.ts';
import { privateResult } from './privacy.ts';
import type { ResultRecord } from './record.ts';

export { ResultConflict } from './error.ts';

function playerRows(record: ResultRecord) {
  return record.players
    .map((player) => ({
      actorId: player.id,
      name: player.name,
      ratingDelta: player.ratingDelta,
    }))
    .sort((left, right) => left.actorId.localeCompare(right.actorId));
}

async function originals(db: Database, id: string) {
  const [result] = await db.select().from(matches).where(eq(matches.matchId, id));
  if (!result?.payload) return;
  const [outbox] = await db
    .select()
    .from(resultOutbox)
    .where(eq(resultOutbox.matchId, id));
  const players = await db
    .select({
      actorId: resultPlayers.actorId,
      name: resultPlayers.name,
      ratingDelta: resultPlayers.ratingDelta,
    })
    .from(resultPlayers)
    .where(eq(resultPlayers.matchId, id));
  if (
    !result.payloadHash ||
    !outbox ||
    result.payloadHash !== (await contentHash(result.payload)) ||
    outbox.payloadHash !== (await contentHash(outbox.payload)) ||
    result.payloadHash !== outbox.payloadHash ||
    canonicalize(
      players.sort((left, right) => left.actorId.localeCompare(right.actorId)),
    ) !== canonicalize(playerRows(result.payload))
  ) {
    throw new ResultConflict();
  }
  return {
    result: { ...result, payload: result.payload, payloadHash: result.payloadHash },
    outbox,
  };
}

export async function commitD1Result(binding: D1Database, source: ResultRecord) {
  const db = connectD1(binding);
  try {
    return await commitResult(db, source);
  } catch (error) {
    if (!(error instanceof ResultConflict)) throw error;
    await changeD1(db, async (writes) => {
      writes.push(
        db
          .update(matches)
          .set({ status: 'conflict' })
          .where(eq(matches.matchId, source.matchId)),
      );
    });
    console.error('RESULT_CONFLICT', source.matchId, JSON.stringify(source));
    throw error;
  }
}

export async function saveResult(env: Env, owner: string, record: ResultRecord) {
  if (record.owner !== owner) throw new ResultConflict();
  if (!env.GAME_D1) throw new Error('RESULT_DATABASE_NOT_CONFIGURED');
  await commitD1Result(env.GAME_D1, record);
}

async function commitResult(db: Database, source: ResultRecord) {
  if (
    !canonicalize(source) ||
    source.players.length === 0 ||
    new Set(source.players.map((player) => player.id)).size !== source.players.length
  ) {
    throw new Error('INVALID_RESULT');
  }
  const { rowsRead, rowsWritten } = await changeD1Batch(db, async (writes) => {
    const record = JSON.parse(
      canonicalize(await privateResult(db, source)) as string,
    ) as ResultRecord;
    const hash = await contentHash(record);
    const existing = await originals(db, record.matchId);
    if (existing) {
      if (existing.result.status === 'conflict') throw new ResultConflict();
      const [saved, delivered] = await Promise.all([
        privateResult(db, existing.result.payload),
        privateResult(db, existing.outbox.payload),
      ]);
      if (
        canonicalize(saved) !== canonicalize(record) ||
        canonicalize(delivered) !== canonicalize(record)
      )
        throw new ResultConflict();
      return;
    }
    writes.push(
      db.insert(matches).values({
        matchId: record.matchId,
        owner: record.owner,
        parentRoomId: record.parentRoomId,
        status:
          record.result.reason === 'connections' ||
          record.result.reason === 'disqualifications'
            ? 'invalid'
            : 'confirmed',
        createdAt: new Date(record.startedAt).toISOString(),
        startedAt: new Date(record.startedAt).toISOString(),
        finishedAt: new Date(record.result.finishedAt).toISOString(),
        payloadHash: hash,
        payload: record,
      }),
      db.insert(resultPlayers).values(
        record.players.map((player) => ({
          matchId: record.matchId,
          actorId: player.id,
          name: player.name,
          ratingDelta: player.ratingDelta,
        })),
      ),
      db
        .insert(resultOutbox)
        .values({ matchId: record.matchId, payloadHash: hash, payload: record }),
    );
    appendResultTrials(writes, [record]);
    await planResultDeliveries(db, writes, record);
  });
  return { rowsRead, rowsWritten };
}

// No caller supplies a replacement. The DB verifies that it is exactly its current privacy projection.
export async function eraseResult(db: Database, id: string) {
  return changeD1(db, async (writes) => {
    const existing = await originals(db, id);
    if (!existing) return false;
    const payload = JSON.parse(
      canonicalize(await privateResult(db, existing.result.payload)) as string,
    ) as ResultRecord;
    if (
      canonicalize(payload) !==
      canonicalize(await privateResult(db, existing.outbox.payload))
    )
      throw new ResultConflict();
    if (canonicalize(payload) === canonicalize(existing.result.payload)) return false;
    const payloadHash = await contentHash(payload);
    writes.push(
      db.insert(resultPrivacyChanges).values({
        matchId: id,
        previousHash: existing.result.payloadHash,
        payloadHash,
        payload,
      }),
      db.update(matches).set({ payload, payloadHash }).where(eq(matches.matchId, id)),
      db
        .update(resultOutbox)
        .set({ payload, payloadHash })
        .where(eq(resultOutbox.matchId, id)),
      db
        .update(resultPlayers)
        .set({
          name: sql`(select json_extract(player.value, '$.name')
        from ${resultPrivacyChanges}, json_each(${resultPrivacyChanges.payload}, '$.players') player
        where ${resultPrivacyChanges.matchId} = ${resultPlayers.matchId}
          and json_extract(player.value, '$.id') = ${resultPlayers.actorId})`,
        })
        .where(eq(resultPlayers.matchId, id)),
      db.delete(resultPrivacyChanges).where(eq(resultPrivacyChanges.matchId, id)),
    );
    return true;
  });
}
