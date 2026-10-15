import canonicalize from 'canonicalize';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { changeD1, connectD1 } from '../db/d1.ts';
import {
  instanceDeletions,
  instances,
  matches,
  organizationAccounts,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import type { State } from '../game/state.ts';
import type { InstanceScope } from '../matchmaking/Matchmaker.ts';
import { OrganizationError } from '../organization/access.ts';
import { privateResult } from './privacy.ts';
import { ratingPolicy } from './rating.ts';
import type { MatchRecord } from './record.ts';

export function matchRecord(state: State): MatchRecord {
  if (!state.definition || state.matchKind === 'development')
    throw new Error('MATCH_DEFINITION_REQUIRED');
  return structuredClone({
    version: 1,
    owner: state.definition.competition.owner,
    matchId: state.matchId,
    kind: state.matchKind,
    ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}),
    definition: { ...state.definition, rules: state.rules },
    questions: state.questions,
    startedAt: state.startedAt ?? null,
    result: null,
    answerStats: [],
    ratingVersion: ratingPolicy.version,
    ...(state.startingRatings ? { startingRatings: state.startingRatings } : {}),
    players: state.players.map((player) => ({ ...player, ratingDelta: 0 })),
  });
}

function database(env: Env) {
  if (!env.GAME_D1) throw new Error('RESULT_DATABASE_NOT_CONFIGURED');
  return connectD1(env.GAME_D1);
}

export async function registerMatch(env: Env, scope: InstanceScope, source: MatchRecord) {
  const db = database(env);
  return changeD1(db, async (writes) => {
    const [instance] = await db
      .select()
      .from(instances)
      .where(and(eq(instances.id, scope.id), eq(instances.owner, scope.owner)));
    if (!instance || instance.state === 'archived')
      throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
    const [deletion] = await db
      .select()
      .from(instanceDeletions)
      .where(eq(instanceDeletions.instanceId, scope.id));
    if (deletion) throw new OrganizationError('INSTANCE_DELETING', 409);
    if (
      source.owner !== scope.owner ||
      source.definition.competition.owner !== scope.owner ||
      source.result ||
      source.startedAt !== null ||
      !source.questions?.length
    )
      throw new Error('INVALID_MATCH');
    const [existing] = await db
      .select()
      .from(matches)
      .where(eq(matches.matchId, source.matchId));
    const record = await privateResult(db, source);
    if (existing) {
      if (existing.status !== 'waiting') throw new Error('MATCH_CLOSED');
      const saved = await privateResult(db, existing.payload);
      if (
        existing.owner !== source.owner ||
        existing.parentRoomId !== (source.parentRoomId ?? null) ||
        canonicalize(saved.definition) !== canonicalize(record.definition) ||
        canonicalize(
          saved.questions?.toSorted((left, right) => left.id.localeCompare(right.id)),
        ) !==
          canonicalize(
            record.questions?.toSorted((left, right) => left.id.localeCompare(right.id)),
          )
      )
        throw new Error('MATCH_DEFINITION_CONFLICT');
      return saved;
    }
    writes.push(
      db.insert(matches).values({
        matchId: record.matchId,
        owner: record.owner,
        parentRoomId: record.parentRoomId,
        status: 'waiting',
        createdAt: new Date().toISOString(),
        payload: record,
      }),
    );
    return record;
  });
}

export async function startMatch(env: Env, source: MatchRecord) {
  if (source.startedAt === null || source.result || !source.players.length)
    throw new Error('INVALID_MATCH_START');
  const db = database(env);
  return changeD1(db, async (writes) => {
    const [existing] = await db
      .select()
      .from(matches)
      .where(eq(matches.matchId, source.matchId));
    if (!existing || !['waiting', 'running'].includes(existing.status))
      throw new Error('MATCH_CLOSED');
    const record = await privateResult(db, source);
    const saved = await privateResult(db, existing.payload);
    if (
      existing.owner !== record.owner ||
      canonicalize(saved.definition) !== canonicalize(record.definition) ||
      canonicalize(saved.questions) !== canonicalize(record.questions)
    )
      throw new Error('MATCH_DEFINITION_CONFLICT');
    if (existing.status === 'running') {
      if (canonicalize(saved) !== canonicalize(record))
        throw new Error('MATCH_START_CONFLICT');
      return;
    }
    const [withdrawn] = await db
      .select({ id: organizationAccounts.actorId })
      .from(organizationAccounts)
      .where(
        and(
          inArray(
            organizationAccounts.actorId,
            source.players.map((player) => player.id),
          ),
          isNotNull(organizationAccounts.withdrawnAt),
        ),
      )
      .limit(1);
    if (withdrawn) throw new Error('MATCH_START_DENIED');
    writes.push(
      db
        .update(matches)
        .set({
          status: 'running',
          startedAt: new Date(source.startedAt as number).toISOString(),
          // 開始時は固定した出題原本を維持し、匿名化は読取投影と確定保存に適用する。
          payload: {
            ...record,
            definition: existing.payload.definition,
            questions: existing.payload.questions,
          },
        })
        .where(eq(matches.matchId, source.matchId)),
    );
  });
}

export async function cancelMatch(env: Env, matchId: string) {
  const db = database(env);
  return changeD1(db, async (writes) => {
    const [existing] = await db
      .select()
      .from(matches)
      .where(eq(matches.matchId, matchId));
    if (!existing) throw new Error('MATCH_NOT_FOUND');
    if (existing.status === 'cancelled') return;
    if (existing.status !== 'waiting') throw new Error('MATCH_NOT_WAITING');
    const cancelledAt = Date.now();
    writes.push(
      db
        .update(matches)
        .set({
          status: 'cancelled',
          finishedAt: new Date(cancelledAt).toISOString(),
          payload: { ...existing.payload, cancelledAt },
        })
        .where(eq(matches.matchId, matchId)),
    );
  });
}
