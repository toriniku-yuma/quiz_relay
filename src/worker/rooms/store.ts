import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { RoomView } from '../../shared/rooms.ts';
import { settings as runtime } from '../../shared/settings.ts';
import { changeD1, connectD1 } from '../db/d1.ts';
import {
  instanceDeletions,
  instanceRooms,
  instances,
  matches,
  roomMembers,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import type { InstanceScope } from '../matchmaking/Matchmaker.ts';
import { OrganizationError } from '../organization/access.ts';
import { allowedInstanceActors } from '../organization/database.ts';
import type { Participant } from './database.ts';
import type { UserRoom } from './RoomLobby.ts';

export const secret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
export async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt: new TextEncoder().encode(salt),
          iterations: 100000,
        },
        key,
        256,
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export function roomData(room: UserRoom) {
  return {
    settings: room.settings,
    hostId: room.hostId,
    revision: room.revision,
    password: room.closed ? null : (room.password ?? null),
    invite: room.closed ? null : room.invite,
    original: room.closed ? null : room.original,
    sourceOwner: room.closed ? null : room.sourceOwner,
    sourceId: room.closed ? null : room.sourceId,
    closed: room.closed,
  };
}
export async function loadRoom(env: Env, id: string) {
  if (!env.GAME_D1) throw new Error('ROOM_DATABASE_REQUIRED');
  const db = connectD1(env.GAME_D1);
  const [row] = await db
    .select({ room: instanceRooms, instance: instances })
    .from(instanceRooms)
    .innerJoin(instances, eq(instances.id, instanceRooms.instanceId))
    .where(eq(instanceRooms.roomId, id));
  if (!row) return;
  const members = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, id), gt(roomMembers.expires, Date.now())))
    .orderBy(asc(roomMembers.joinedAt), asc(roomMembers.actorId));
  return { ...row, members };
}
export async function roomInstanceDeleted(env: Env, instanceId: string) {
  if (!env.GAME_D1) throw new Error('ROOM_DATABASE_REQUIRED');
  const [deleted] = await connectD1(env.GAME_D1)
    .select({ id: instanceDeletions.instanceId })
    .from(instanceDeletions)
    .leftJoin(instances, eq(instances.id, instanceDeletions.instanceId))
    .where(
      and(
        eq(instanceDeletions.instanceId, instanceId),
        isNotNull(instanceDeletions.acceptedAt),
        isNotNull(instanceDeletions.deletedAt),
        isNull(instances.id),
      ),
    );
  return !!deleted;
}
export async function createRoom(env: Env, room: UserRoom, actor: string, hash: string) {
  if (!env.GAME_D1) throw new Error('ROOM_DATABASE_REQUIRED');
  const db = connectD1(env.GAME_D1);
  return changeD1(db, async (writes) => {
    const [instance] = await db
      .select()
      .from(instances)
      .where(and(eq(instances.id, room.scope.id), eq(instances.owner, room.scope.owner)));
    if (!instance || instance.state === 'archived')
      throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
    const [deletion] = await db
      .select()
      .from(instanceDeletions)
      .where(eq(instanceDeletions.instanceId, instance.id));
    if (deletion) throw new OrganizationError('INSTANCE_DELETING', 409);
    const [existing] = await db
      .select()
      .from(instanceRooms)
      .where(eq(instanceRooms.roomId, room.id));
    if (existing) {
      if (existing.closed) throw new OrganizationError('ROOM_CLOSED', 409);
      if (
        existing.instanceId !== room.scope.id ||
        existing.creatorId !== actor ||
        existing.creationHash !== hash
      )
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      return;
    }
    writes.push(
      db.insert(instanceRooms).values({
        roomId: room.id,
        instanceId: room.scope.id,
        creatorId: actor,
        creationHash: hash,
        createdAt: room.createdAt,
        ...roomData(room),
      }),
    );
  });
}
export async function saveRoomData(
  env: Env,
  room: UserRoom,
  before: ReturnType<typeof roomData>,
) {
  const after = roomData(room);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (!env.GAME_D1) throw new Error('ROOM_DATABASE_REQUIRED');
  const db = connectD1(env.GAME_D1);
  await changeD1(db, async (writes) => {
    const [current] = await db
      .select()
      .from(instanceRooms)
      .where(eq(instanceRooms.roomId, room.id));
    if (!current || current.closed) throw new OrganizationError('ROOM_CLOSED', 409);
    if (current.revision !== before.revision)
      throw new OrganizationError('EDIT_CONFLICT', 409);
    writes.push(
      db.update(instanceRooms).set(after).where(eq(instanceRooms.roomId, room.id)),
    );
    if (room.closed)
      writes.push(db.delete(roomMembers).where(eq(roomMembers.roomId, room.id)));
  });
}
export async function leaveRoom(
  env: Env,
  room: string,
  actor: string,
  generation?: string,
) {
  if (!env.GAME_D1) throw new Error('ROOM_DATABASE_REQUIRED');
  const db = connectD1(env.GAME_D1);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .delete(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, room),
            eq(roomMembers.actorId, actor),
            generation ? eq(roomMembers.generation, generation) : undefined,
          ),
        ),
    );
  });
}
export async function joinRoom(
  env: Env,
  roomId: string,
  actor: Participant,
  token: string,
  generation: string,
  password: string,
  invite: string,
  scope: InstanceScope,
) {
  const initial = await loadRoom(env, roomId);
  if (!initial || initial.room.closed) return { ok: false as const, code: 'ROOM_CLOSED' };
  if (
    initial.room.instanceId !== scope.id ||
    initial.instance.owner !== scope.owner ||
    scope.mode !== 'room'
  )
    return { ok: false as const, code: 'INSTANCE_MISMATCH' };
  const existing = initial.members.find((member) => member.actorId === actor.id);
  if (existing)
    return existing.generation === generation && existing.token === token
      ? { ok: true as const, expires: existing.expires }
      : { ok: false as const, code: 'STALE_RESERVATION' };
  if (!initial.room.settings.public && initial.room.invite !== invite)
    return { ok: false as const, code: 'INVITE_REQUIRED' };
  if (
    initial.room.password &&
    (await passwordHash(password, initial.room.password.salt)) !==
      initial.room.password.hash
  )
    return { ok: false as const, code: 'PASSWORD_INCORRECT' };
  if (
    !(await allowedInstanceActors(env, scope, [actor.id])).includes(actor.id) ||
    (actor.guest && !initial.room.settings.guests)
  )
    return { ok: false as const, code: 'PARTICIPATION_RESTRICTED' };
  if (!env.GAME_D1) throw new Error('ROOM_DATABASE_REQUIRED');
  const db = connectD1(env.GAME_D1),
    now = Date.now(),
    expires = now + runtime.lobby.sessionLifetimeMs;
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .insert(roomMembers)
        .select(
          db
            .select({
              roomId: sql<string>`${roomId}`.as('room_id'),
              actorId: sql<string>`${actor.id}`.as('actor_id'),
              name: sql<string>`${actor.name}`.as('name'),
              serverName: sql<string | null>`${actor.serverName ?? null}`.as(
                'server_name',
              ),
              guest: sql<boolean>`${Number(actor.guest)}`.as('guest'),
              token: sql<string>`${token}`.as('token'),
              generation: sql<string>`${generation}`.as('generation'),
              joinedAt: sql<number>`${now}`.as('joined_at'),
              expires: sql<number>`${expires}`.as('expires'),
            })
            .from(instanceRooms)
            .where(
              and(
                eq(instanceRooms.roomId, roomId),
                eq(instanceRooms.closed, false),
                eq(instanceRooms.revision, initial.room.revision),
                sql`(select count(*) from ${roomMembers} where ${roomMembers.roomId}=${roomId} and ${roomMembers.expires}>${now}) < json_extract(${instanceRooms.settings},'$.capacity') + json_extract(${instanceRooms.settings},'$.presenter')`,
              ),
            ),
        )
        .onConflictDoUpdate({
          target: [roomMembers.roomId, roomMembers.actorId],
          set: {
            name: actor.name,
            serverName: actor.serverName,
            guest: actor.guest,
            token,
            generation,
            joinedAt: now,
            expires,
          },
          setWhere: sql`${roomMembers.expires}<=${now}`,
        }),
    );
  });
  const [member] = await db
    .select()
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.actorId, actor.id),
        eq(roomMembers.generation, generation),
        eq(roomMembers.token, token),
        gt(roomMembers.expires, now),
      ),
    );
  return member
    ? { ok: true as const, expires: member.expires }
    : { ok: false as const, code: 'ROOM_FULL' };
}
export async function roomViews(env: Env, instanceId?: string, id?: string, invite = '') {
  if (!env.GAME_D1) throw new Error('ROOM_DATABASE_REQUIRED');
  const db = connectD1(env.GAME_D1),
    now = Date.now();
  const rows = await db
    .select({
      room: instanceRooms,
      memberCount:
        sql<number>`(select count(*) from ${roomMembers} where ${roomMembers.roomId}="quiz_game_instance_rooms"."room_id" and ${roomMembers.expires}>${now})`.mapWith(
          Number,
        ),
      playing:
        sql<boolean>`exists(select 1 from ${matches} where ${matches.parentRoomId}="quiz_game_instance_rooms"."room_id" and ${matches.status} in ('waiting','running'))`.mapWith(
          Boolean,
        ),
      hostName: sql<
        string | null
      >`(select ${roomMembers.name} from ${roomMembers} where ${roomMembers.roomId}="quiz_game_instance_rooms"."room_id" and ${roomMembers.actorId}="quiz_game_instance_rooms"."host_id" and ${roomMembers.expires}>${now})`,
      hostServerName: sql<
        string | null
      >`(select ${roomMembers.serverName} from ${roomMembers} where ${roomMembers.roomId}="quiz_game_instance_rooms"."room_id" and ${roomMembers.actorId}="quiz_game_instance_rooms"."host_id" and ${roomMembers.expires}>${now})`,
    })
    .from(instanceRooms)
    .where(
      and(
        eq(instanceRooms.closed, false),
        instanceId ? eq(instanceRooms.instanceId, instanceId) : undefined,
        id ? eq(instanceRooms.roomId, id) : undefined,
        id
          ? sql`(json_extract(${instanceRooms.settings},'$.public')=1 or ${instanceRooms.invite}=${invite})`
          : sql`json_extract(${instanceRooms.settings},'$.public')=1`,
      ),
    );
  return rows.map(
    ({
      room,
      memberCount,
      hostName,
      hostServerName,
      playing,
    }): RoomView & { memberCount: number } => ({
      id: room.roomId,
      instanceId: room.instanceId,
      settings: room.settings,
      hostId: room.hostId,
      hostName,
      hostServerName,
      password: !!room.password,
      revision: room.revision,
      closed: room.closed,
      members: [],
      memberCount,
      playing,
      matchRoom: null,
      waiting: false,
    }),
  );
}
