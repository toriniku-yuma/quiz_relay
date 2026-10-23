import type { ConnectionReport } from '../../shared/connection-report.ts';
import type { Snapshot } from '../../shared/game.ts';
import type {
  BroughtQuestion,
  RoomMember,
  RoomSettings,
  RoomView,
} from '../../shared/rooms.ts';
import { validateBroughtSet, validateRoomSettings } from '../../shared/rooms.ts';
import { settings as runtime } from '../../shared/settings.ts';
import { type MatchDefinition, validateDefinition } from '../catalog/definition.ts';
import { contentHash } from '../catalog/hash.ts';
import type { Env } from '../env.ts';
import { refreshParticipationAccess } from '../federation/participation.ts';
import { matchRoomName } from '../game/room-names.ts';
import { deleteStored, readStored, writeStored } from '../game/storage.ts';
import { connectionId, failureDetails } from '../http/diagnostics.ts';
import type { InstanceScope } from '../matchmaking/Matchmaker.ts';
import { OrganizationError, validId } from '../organization/access.ts';
import { allowedInstanceActors } from '../organization/database.ts';
import { type Participant, roomDefinition } from './database.ts';
import {
  createRoom,
  joinRoom,
  leaveRoom,
  loadRoom,
  passwordHash,
  roomData,
  roomInstanceDeleted,
  roomViews,
  saveRoomData,
  secret,
} from './store.ts';

type Member = RoomMember & {
  token: string;
  generation: string;
  expires: number;
  inLobby: boolean;
};
export type UserRoom = {
  createdAt: number;
  id: string;
  scope: InstanceScope;
  settings: RoomSettings;
  hostId: string;
  revision: number;
  password?: { salt: string; hash: string };
  invite: string;
  original: BroughtQuestion[];
  sourceOwner: string;
  sourceId: string;
  playing: boolean;
  members: Member[];
  closed: boolean;
  emptySince?: number;
  childSessionExpires?: number;
  match?: { id: string; actors: string[]; tokens: Record<string, string> };
  starting?: {
    operationId: string;
    hash: string;
    revision: number;
    id: string;
    expires?: number;
  };
};
type Attachment = {
  reportReceived: boolean;
  clientReport?: ConnectionReport;
  actorId: string;
  live: boolean;
  lastSeen: number;
  connectionId: string;
  roomId: string;
};
type ChildSession = {
  actor: string;
  room: string;
  token: string;
  parentToken: string;
  generation: string;
  expires: number;
};
type PreparedStart = {
  actor: string;
  hash: string;
  id: string;
  definition: MatchDefinition;
  tokens: Record<string, string>;
  members: (Participant & { role?: 'presenter' })[];
};
type LiveRoom = Pick<
  UserRoom,
  'id' | 'playing' | 'emptySince' | 'childSessionExpires' | 'match' | 'starting'
> & {
  instanceId: string;
  members: { id: string; generation: string; ready: boolean; inLobby: boolean }[];
};
// Each match uses its own GameRoom. A new match never replaces the previous match's original or retry alarm.
export class RoomLobby {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}
  private async atomic<T>(operation: () => Promise<T>): Promise<T> {
    // Expected admission errors must not reset the Durable Object and disconnect the whole lobby.
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        return { value: await operation() };
      } catch (error) {
        if (error instanceof OrganizationError) return { error };
        console.error(
          JSON.stringify({
            event: 'room_lobby_failed',
            objectId: this.ctx.id.toString(),
            ...failureDetails(error),
          }),
        );
        throw error;
      }
    });
    if ('error' in result) throw result.error;
    return result.value;
  }
  private child(id: string) {
    return this.env.GAME_ROOM.getByName(matchRoomName(id));
  }
  private persisted = new WeakMap<UserRoom, ReturnType<typeof roomData>>();
  async read() {
    const live = await readStored<LiveRoom>(this.ctx.storage, 'user-room');
    if (!live) return;
    if (!live.instanceId) throw new Error('ROOM_INSTANCE_REQUIRED');
    const stored = await loadRoom(this.env, live.id);
    if (!stored) {
      if (!(await roomInstanceDeleted(this.env, live.instanceId)))
        throw new Error('ROOM_DATA_INCOMPLETE');
      for (const socket of this.sockets()) this.close(socket, 'ROOM_CLOSED');
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const { room: row, instance, members } = stored;
    if (instance.id !== live.instanceId) throw new Error('ROOM_INSTANCE_MISMATCH');
    if (
      !row.closed &&
      (row.invite === null ||
        row.original === null ||
        row.sourceId === null ||
        row.sourceOwner === null)
    )
      throw new Error('ROOM_DATA_INCOMPLETE');
    const room: UserRoom = {
      ...live,
      createdAt: row.createdAt,
      scope: { id: row.instanceId, owner: instance.owner, mode: 'room' },
      settings: row.settings,
      hostId: row.hostId,
      revision: row.revision,
      password: row.password ?? undefined,
      invite: row.closed ? '' : (row.invite as string),
      original: row.closed ? [] : (row.original as BroughtQuestion[]),
      sourceOwner: row.closed ? '' : (row.sourceOwner as string),
      sourceId: row.closed ? '' : (row.sourceId as string),
      closed: row.closed,
      members: members.map(({ actorId, roomId: _, ...member }) => {
        const flags = live.members.find(
          (entry) => entry.id === actorId && entry.generation === member.generation,
        );
        return {
          ...member,
          id: actorId,
          ready: flags?.ready === true,
          inLobby: flags ? flags.inLobby : true,
          connected: this.sockets().some(
            (socket) =>
              (socket.deserializeAttachment() as Attachment).actorId === actorId,
          ),
        };
      }),
    };
    this.persisted.set(room, roomData(room));
    return room;
  }
  async createdInvite(actor: string) {
    const room = await this.read();
    if (!room || room.closed) throw new OrganizationError('ROOM_CLOSED', 409);
    const stored = await loadRoom(this.env, room.id);
    if (stored?.room.creatorId !== actor)
      throw new OrganizationError('ROOM_HOST_REQUIRED');
    return room.invite;
  }
  async create(
    id: string,
    scope: InstanceScope,
    actor: Participant,
    input: Record<string, unknown>,
  ) {
    if (actor.guest) throw new OrganizationError('LOGIN_REQUIRED');
    const hash = await contentHash(input),
      configuration = validateRoomSettings(input.settings);
    const original =
      configuration.source === 'original' ? validateBroughtSet(input.questions) : [];
    const password = typeof input.password === 'string' ? input.password : '';
    if (password.length > 128) throw new OrganizationError('INVALID_PASSWORD', 400);
    const salt = secret(),
      encrypted = password
        ? { salt, hash: await passwordHash(password, salt) }
        : undefined;
    await this.atomic(async () => {
      const room: UserRoom = {
        createdAt: Date.now(),
        id,
        scope,
        settings: configuration,
        hostId: actor.id,
        revision: 0,
        password: encrypted,
        invite: secret(),
        original,
        sourceOwner: actor.id,
        sourceId: crypto.randomUUID(),
        playing: false,
        members: [],
        closed: false,
        emptySince: Date.now(),
      };
      await createRoom(this.env, room, actor.id, hash);
      const previous = await this.read();
      if (previous) return;
      this.persisted.set(room, roomData(room));
      await this.save(room);
    });
    return { ok: true as const, room: id };
  }
  async join(
    actor: Participant,
    token: string,
    generation: string,
    password: string,
    invite: string,
    scope: InstanceScope,
  ) {
    const initial = await this.read();
    if (!initial || initial.closed) return { ok: false as const, code: 'ROOM_CLOSED' };
    if (await this.ctx.storage.get(`closed:${generation}`))
      return { ok: false as const, code: 'STALE_RESERVATION' };
    const result = await joinRoom(
      this.env,
      initial.id,
      actor,
      token,
      generation,
      password,
      invite,
      scope,
    );
    if (result.ok)
      await this.atomic(async () => {
        const room = await this.read();
        if (!room) return;
        this.sweep(room);
        await this.save(room);
        this.broadcast(room);
      });
    return result;
  }
  async info(invite = '') {
    const room = await this.read();
    if (!room) throw new OrganizationError('ROOM_NOT_FOUND', 404);
    const [view] = await roomViews(this.env, undefined, room.id, invite);
    if (!view) throw new OrganizationError('ROOM_NOT_FOUND', 404);
    return view;
  }
  async viewFor(actor: string, token?: string) {
    const room = await this.read();
    if (
      !room?.members.some(
        (member) =>
          member.id === actor &&
          (!token || member.token === token) &&
          member.expires > Date.now(),
      )
    )
      throw new OrganizationError('ROOM_NOT_FOUND', 404);
    return this.view(room, actor);
  }
  async originals(actor: string) {
    const room = await this.read();
    if (
      !room ||
      room.sourceOwner !== actor ||
      !room.members.some((member) => member.id === actor)
    )
      throw new OrganizationError('AUTHOR_REQUIRED');
    return { questions: room.original };
  }
  async mutate(actor: Participant, input: Record<string, unknown>) {
    const operationId = validId(input.operationId),
      hash = await contentHash(input);
    if (input.action === 'start') return this.start(actor, input, operationId, hash);
    await this.status();
    const snapshot = await this.read();
    if (!snapshot) throw new OrganizationError('ROOM_NOT_FOUND', 404);
    if (input.action === 'ready')
      await refreshParticipationAccess(
        this.env,
        snapshot.scope.id,
        [actor.id],
        true,
        undefined,
        false,
        snapshot.id,
      );
    const allowed = await allowedInstanceActors(this.env, snapshot.scope, [actor.id]);
    const password = typeof input.password === 'string' ? input.password : undefined;
    if (password !== undefined && password.length > 128)
      throw new OrganizationError('INVALID_PASSWORD', 400);
    const salt = secret(),
      encrypted = password
        ? { salt, hash: await passwordHash(password, salt) }
        : undefined;
    const result = await this.atomic(async () => {
      const prior = await this.ctx.storage.get<{
        actor: string;
        hash: string;
        result: { ok: true };
      }>(`operation:${operationId}`);
      if (prior) {
        if (prior.actor !== actor.id || prior.hash !== hash)
          throw new OrganizationError('OPERATION_CONFLICT', 409);
        return prior.result;
      }
      const room = await this.read(),
        member = room?.members.find((candidateMember) => candidateMember.id === actor.id);
      if (!room || !member || room.closed)
        throw new OrganizationError('ROOM_NOT_FOUND', 404);
      if (room.starting) throw new OrganizationError('START_PENDING', 409);
      if (input.action === 'ready') {
        if (
          !member.inLobby ||
          !allowed.includes(actor.id) ||
          (actor.guest && !room.settings.guests)
        )
          throw new OrganizationError('PARTICIPATION_RESTRICTED', 409);
        if (typeof input.ready !== 'boolean')
          throw new OrganizationError('INVALID_SETUP', 400);
        member.ready = input.ready;
      } else if (input.action === 'return') {
        if (room.playing) throw new OrganizationError('MATCH_STARTED', 409);
        member.inLobby = true;
      } else {
        if (room.hostId !== actor.id) throw new OrganizationError('ROOM_HOST_REQUIRED');
        if (input.revision !== room.revision)
          throw new OrganizationError('EDIT_CONFLICT', 409);
        if (input.action === 'settings') {
          const next = validateRoomSettings(input.settings);
          if (room.members.length > next.capacity + (next.presenter ? 1 : 0))
            throw new OrganizationError('ROOM_FULL', 409);
          if (actor.guest && input.questions !== undefined)
            throw new OrganizationError('LOGIN_REQUIRED');
          if (next.source === 'original' && input.questions !== undefined) {
            room.original = validateBroughtSet(input.questions);
            room.sourceOwner = actor.id;
            room.sourceId = crypto.randomUUID();
          }
          if (next.source === 'original' && !room.original.length)
            throw new OrganizationError('NO_ROOM_QUESTIONS', 409);
          room.settings = next;
          if (password !== undefined) room.password = encrypted;
          room.revision++;
          this.unready(room);
        } else if (input.action === 'invite') {
          room.invite = secret();
          room.revision++;
        } else if (input.action === 'close') {
          room.closed = true;
          room.revision++;
        } else throw new OrganizationError('INVALID_OPERATION', 400);
      }
      await this.save(room, {
        [`operation:${operationId}`]: { actor: actor.id, hash, result: { ok: true } },
      });
      this.broadcast(room);
      return { ok: true as const };
    });
    return result;
  }
  private async start(
    actor: Participant,
    input: Record<string, unknown>,
    operationId: string,
    hash: string,
  ) {
    const recovery = await readStored<PreparedStart>(
      this.ctx.storage,
      `start:${operationId}`,
    );
    if (recovery) {
      if (recovery.actor !== actor.id || recovery.hash !== hash)
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      return this.finishStart(recovery, operationId);
    }
    const prepared = await this.atomic(async () => {
      const previous = await this.ctx.storage.get<{
        actor: string;
        hash: string;
        result: { ok: true; room: string };
      }>(`operation:${operationId}`);
      if (previous) {
        if (previous.actor !== actor.id || previous.hash !== hash)
          throw new OrganizationError('OPERATION_CONFLICT', 409);
        return { previous: previous.result };
      }
      const room = await this.read();
      if (!room || room.closed || room.hostId !== actor.id)
        throw new OrganizationError('ROOM_HOST_REQUIRED');
      this.sweep(room);
      if (input.revision !== room.revision)
        throw new OrganizationError('EDIT_CONFLICT', 409);
      if (
        room.starting &&
        (room.starting.operationId !== operationId || room.starting.hash !== hash)
      )
        throw new OrganizationError('START_PENDING', 409);
      const answerers = room.members.filter(
        (member) => !room.settings.presenter || member.id !== room.hostId,
      );
      if (
        answerers.length < 2 ||
        answerers.length > room.settings.capacity ||
        answerers.some((member) => !member.connected || !member.ready || !member.inLobby)
      )
        throw new OrganizationError('ROOM_NOT_READY', 409);
      room.starting ??= {
        operationId,
        hash,
        revision: room.revision,
        id: crypto.randomUUID(),
      };
      room.starting.expires = Date.now() + runtime.lobby.reservationLifetimeMs;
      await this.save(room);
      return { room: structuredClone(room) };
    });
    if (prepared.previous) return prepared.previous;
    const initial = prepared.room;
    if (!initial?.starting) throw new OrganizationError('START_PENDING', 409);
    const childId = initial.starting.id;
    try {
      const previousStatus = initial.match
        ? await this.child(initial.match.id).lobbyStatus()
        : null;
      if (this.isPlaying(previousStatus))
        throw new OrganizationError('MATCH_STARTED', 409);
      await refreshParticipationAccess(
        this.env,
        initial.scope.id,
        initial.members.map((member) => member.id),
        true,
        undefined,
        false,
        initial.id,
      );
      const allowed = await allowedInstanceActors(
        this.env,
        initial.scope,
        initial.members.map((member) => member.id),
      );
      if (
        initial.members.some(
          (member) =>
            !allowed.includes(member.id) || (member.guest && !initial.settings.guests),
        )
      )
        throw new OrganizationError('PARTICIPATION_RESTRICTED', 409);
      const definition = await roomDefinition(
        this.env,
        initial.scope,
        initial.settings,
        initial.original,
        initial.sourceId,
      );
      definition.playersPerMatch = initial.members.filter(
        (member) => !initial.settings.presenter || member.id !== initial.hostId,
      ).length;
      try {
        await validateDefinition(definition);
      } catch {
        throw new OrganizationError('INVALID_SETUP', 400);
      }
      const tokens = Object.fromEntries(
        initial.members.map((member) => [member.id, secret()]),
      );
      // Persist the child identity and credentials before an RPC whose outcome could be unknown.
      const fixed = await this.atomic(async () => {
        const room = await this.read();
        if (
          !room?.starting ||
          room.starting.operationId !== operationId ||
          room.revision !== initial.revision
        )
          throw new OrganizationError('EDIT_CONFLICT', 409);
        this.sweep(room);
        if (
          JSON.stringify(
            room.members.map((member) => [
              member.id,
              member.generation,
              member.ready,
              member.inLobby,
            ]),
          ) !==
            JSON.stringify(
              initial.members.map((member) => [
                member.id,
                member.generation,
                member.ready,
                member.inLobby,
              ]),
            ) ||
          room.members.some((member) => !member.connected)
        )
          throw new OrganizationError('ROOM_NOT_READY', 409);
        const key = `start:${operationId}`;
        const saved = await readStored<PreparedStart>(this.ctx.storage, key);
        if (saved) return saved;
        const pending: PreparedStart = {
          actor: actor.id,
          hash,
          id: childId,
          definition,
          tokens,
          members: initial.members.map((member) => ({
            id: member.id,
            name: member.name,
            serverName: member.serverName,
            guest: member.guest,
            ...(initial.settings.presenter && member.id === initial.hostId
              ? { role: 'presenter' as const }
              : {}),
          })),
        };
        await this.ctx.storage.transaction((tx) => writeStored(tx, key, pending));
        return pending;
      });
      return await this.finishStart(fixed, operationId);
    } catch (error) {
      // A prepared child may have started. Only release the latch before any child RPC was prepared.
      if (
        error instanceof OrganizationError &&
        !(await this.ctx.storage.get(`start:${operationId}`))
      )
        await this.atomic(async () => {
          const room = await this.read();
          if (room?.starting?.operationId === operationId) {
            room.starting = undefined;
            await this.save(room);
          }
        });
      throw error;
    }
  }
  private async finishStart(fixed: PreparedStart, operationId: string) {
    const initial = await this.read();
    if (!initial) throw new OrganizationError('ROOM_NOT_FOUND', 404);
    await this.child(fixed.id).initializeRoomMatch(
      fixed.id,
      fixed.definition,
      initial.scope,
      fixed.members,
      fixed.tokens,
      initial.id,
    );
    const latest = await this.read();
    for (const member of fixed.members) {
      const before = initial.members.find((candidate) => candidate.id === member.id);
      const current = latest?.members.find((candidate) => candidate.id === member.id);
      if (
        (!before || !current || before.generation !== current.generation) &&
        !(await this.child(fixed.id).cancelReservation(
          'match',
          member.id,
          true,
          undefined,
          fixed.tokens[member.id],
        ))
      )
        throw new OrganizationError('START_PENDING', 409);
    }
    return this.atomic(async () => {
      const previous = await this.ctx.storage.get<{
        actor: string;
        hash: string;
        result: { ok: true; room: string };
      }>(`operation:${operationId}`);
      if (previous) return previous.result;
      const room = await this.read();
      if (!room?.starting || room.starting.operationId !== operationId)
        throw new OrganizationError('START_PENDING', 409);
      room.match = {
        id: fixed.id,
        actors: fixed.members.map((member) => member.id),
        tokens: fixed.tokens,
      };
      room.playing = true;
      for (const member of room.members)
        if (room.match.actors.includes(member.id)) member.inLobby = false;
      const result = { ok: true as const, room: fixed.id };
      const expires = Date.now() + runtime.lobby.sessionLifetimeMs;
      const sessions = Object.fromEntries(
        room.members
          .filter((member) => fixed.members.some((selected) => selected.id === member.id))
          .map((roomMember) => [
            `child-session:${roomMember.id}:${fixed.id}`,
            {
              actor: roomMember.id,
              room: fixed.id,
              token: fixed.tokens[roomMember.id],
              parentToken: roomMember.token,
              generation: roomMember.generation,
              expires,
            } satisfies ChildSession,
          ]),
      );
      room.childSessionExpires = Math.min(room.childSessionExpires ?? expires, expires);
      room.starting = undefined;
      this.unready(room);
      await this.save(
        room,
        {
          ...sessions,
          [`operation:${operationId}`]: { actor: fixed.actor, hash: fixed.hash, result },
        },
        [`start:${operationId}`],
      );
      this.broadcast(room);
      return result;
    });
  }
  async gameSession(actor: string, token: string) {
    const room = await this.read();
    const member = room?.members.find(
      (candidateMember) =>
        candidateMember.id === actor && candidateMember.token === token,
    );
    if (!room?.match || !member || member.inLobby || !room.match.actors.includes(actor))
      throw new OrganizationError('MATCH_NOT_FOUND', 404);
    return { room: room.match.id, token: room.match.tokens[actor] };
  }
  async matchFinished(matchId: string) {
    await this.atomic(async () => {
      const room = await this.read();
      if (room?.starting?.id === matchId)
        throw new OrganizationError('START_PENDING', 409);
      if (!room || room.match?.id !== matchId) return;
      for (const member of Object.values(room.members)) member.inLobby = true;
      room.match = undefined;
      room.playing = false;
      this.unready(room);
      await this.save(room);
      this.broadcast(room);
    });
  }

  async status(): Promise<{
    phase: Snapshot['phase'];
    closed: boolean;
    actors: string[];
    capacity: number;
  } | null> {
    const room = await this.read();
    if (!room) return null;
    return this.atomic(async () => {
      const latest = await this.read();
      if (!latest) return null;
      const playing = latest.playing;
      this.sweep(latest);
      await this.save(latest);
      this.broadcast(latest);
      return {
        phase: playing ? ('REVEALING' as const) : ('WAITING' as const),
        closed: latest.closed && !playing,
        actors: [
          ...new Set([
            ...latest.members.map((member) => member.id),
            ...(playing ? (latest.match?.actors ?? []) : []),
          ]),
        ],
        capacity: latest.settings.capacity,
      };
    });
  }
  async cancel(
    actor: string,
    revoke = false,
    generation?: string,
    token?: string,
    forfeit = false,
  ) {
    const room = await this.read();
    if (!room) return true;
    const member = room.members.find((candidateMember) => candidateMember.id === actor);
    if (
      member &&
      ((generation && member.generation !== generation) ||
        (token && member.token !== token))
    ) {
      if (revoke) await this.revokeChildren(actor, generation, token, forfeit);
      return false;
    }
    const current = room.match ? await this.child(room.match.id).lobbyStatus() : null;
    const playing = this.isPlaying(current) && !!room.match?.actors.includes(actor);
    if (playing && !revoke) return false;
    const result = await this.atomic(async () => {
      const latest = await this.read();
      if (!latest) return true;
      const latestMember = latest.members.find((member) => member.id === actor);
      if (
        latestMember &&
        ((generation && latestMember.generation !== generation) ||
          (token && latestMember.token !== token))
      ) {
        if (revoke) await this.revokeChildren(actor, generation, token, forfeit);
        return false;
      }
      // The checked child status only applies to the same match.
      if (
        !revoke &&
        latest.match?.actors.includes(actor) &&
        latest.match.id !== room.match?.id
      )
        return false;
      if (revoke) {
        if (!(await this.revokeChildren(actor, undefined, undefined, forfeit)))
          return false;
        if (
          latest.match?.tokens[actor] &&
          !(await this.child(latest.match.id).cancelReservation(
            'match',
            actor,
            true,
            undefined,
            latest.match.tokens[actor],
            forfeit,
          ))
        )
          return false;
      }
      if (latest?.starting) {
        const fixed = await readStored<PreparedStart>(
          this.ctx.storage,
          `start:${latest.starting.operationId}`,
        );
        if (fixed && !revoke) return false;
        if (
          fixed &&
          revoke &&
          fixed.tokens[actor] &&
          !(await this.child(fixed.id).cancelReservation(
            'match',
            actor,
            true,
            undefined,
            fixed.tokens[actor],
            forfeit,
          ))
        )
          return false;
      }
      if (generation) await this.ctx.storage.put(`closed:${generation}`, true);
      for (const socket of this.sockets())
        if ((socket.deserializeAttachment() as Attachment).actorId === actor)
          this.close(socket, forfeit ? 'MATCH_REPLACED' : undefined);
      await leaveRoom(this.env, latest.id, actor, generation);
      latest.members = latest.members.filter(
        (remainingMember) => remainingMember.id !== actor,
      );
      latest.revision++;
      this.sweep(latest);
      await this.save(latest);
      this.broadcast(latest);
      return true;
    });
    return result;
  }
  private async revokeChildren(
    actor: string,
    generation?: string,
    token?: string,
    forfeit = false,
  ) {
    const sessions = await this.ctx.storage.list<ChildSession>({
      prefix: `child-session:${actor}:`,
    });
    const matching = [...sessions].filter(
      ([, session]) =>
        (!generation || session.generation === generation) &&
        (!token || session.parentToken === token),
    );
    for (const [, session] of matching)
      if (
        !(await this.child(session.room).cancelReservation(
          'match',
          actor,
          true,
          undefined,
          session.token,
          forfeit,
        ))
      )
        return false;
    if (matching.length) await this.ctx.storage.delete(matching.map(([key]) => key));
    return true;
  }
  async fetch(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 426 });
    const socketId = connectionId(request);
    if (socketId === null)
      return Response.json({ code: 'INVALID_CONNECTION_ID' }, { status: 400 });
    return this.atomic(async () => {
      const room = await this.read(),
        token = request.headers.get('X-Game-Session');
      const member = room?.members.find(
        (candidateMember) =>
          candidateMember.token === token && candidateMember.expires > Date.now(),
      );
      if (!room || !member || room.scope.id !== request.headers.get('X-Game-Instance'))
        return new Response(null, { status: 401 });
      if (
        this.sockets().filter(
          (socket) =>
            (socket.deserializeAttachment() as Attachment).actorId === member.id,
        ).length >= runtime.game.maxConnectionsPerActor
      )
        return new Response(null, { status: 429 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [member.id]);
      pair[1].serializeAttachment({
        reportReceived: false,
        connectionId: socketId,
        roomId: room.id,
        actorId: member.id,
        live: true,
        lastSeen: Date.now(),
      });
      this.sweep(room);
      await this.save(room);
      this.broadcast(room);
      console.info(
        JSON.stringify({
          event: 'room_lobby_connected',
          at: Date.now(),
          objectId: this.ctx.id.toString(),
          roomId: room.id,
          connectionId: (pair[1].deserializeAttachment() as Attachment).connectionId,
          sockets: this.sockets().length,
        }),
      );
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }
  async message(socket: WebSocket, message: string | ArrayBuffer) {
    if (message !== 'sync') {
      this.close(socket, undefined, 'WS_PROTOCOL');
      return;
    }
    await this.atomic(async () => {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (!attachment.live) return;
      attachment.lastSeen = Date.now();
      socket.serializeAttachment(attachment);
      const room = await this.read();
      if (!room) return;
      this.sweep(room);
      await this.save(room);
      this.broadcast(room);
    });
  }
  async disconnect(socket: WebSocket) {
    let stage = 'gate';
    try {
      await this.atomic(async () => {
        stage = 'close';
        this.close(socket, undefined, 'WS_DISCONNECTED');
        stage = 'read';
        const room = await this.read();
        if (room) {
          stage = 'sweep';
          this.sweep(room);
          stage = 'save';
          await this.save(room);
          stage = 'broadcast';
          this.broadcast(room);
        }
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'room_disconnect_failed',
          objectId: this.ctx.id.toString(),
          connectionId: (socket.deserializeAttachment() as Attachment).connectionId,
          stage,
          ...failureDetails(error),
        }),
      );
      throw error;
    }
  }
  async alarm() {
    await this.atomic(async () => {
      const room = await this.read();
      if (!room?.childSessionExpires || room.childSessionExpires > Date.now()) return;
      const sessions = await this.ctx.storage.list<ChildSession>({
        prefix: 'child-session:',
      });
      const expired = [...sessions]
        .filter(([, session]) => session.expires <= Date.now())
        .map(([key]) => key);
      if (expired.length) await this.ctx.storage.delete(expired);
      const deadlines = [...sessions.values()]
        .filter((session) => session.expires > Date.now())
        .map((session) => session.expires);
      room.childSessionExpires = deadlines.length ? Math.min(...deadlines) : undefined;
      await this.save(room);
    });
    const room = await this.read();
    if (room?.starting) {
      const operationId = room.starting.operationId;
      const pending = await readStored<PreparedStart>(
        this.ctx.storage,
        `start:${operationId}`,
      );
      try {
        if (pending) await this.finishStart(pending, operationId);
        else if ((room.starting.expires ?? 0) <= Date.now()) {
          // Allow live admission checks to finish before recovering an abandoned start.
          await this.atomic(async () => {
            const latest = await this.read();
            if (
              latest?.starting?.operationId === operationId &&
              (latest.starting.expires ?? 0) <= Date.now() &&
              !(await this.ctx.storage.get(`start:${operationId}`))
            ) {
              latest.starting = undefined;
              await this.save(latest);
            }
          });
        }
      } catch {
        await this.ctx.storage.setAlarm(
          Date.now() + runtime.connection.heartbeatTimeoutMs,
        );
      }
    }
    await this.status();
  }
  private sockets() {
    return this.ctx
      .getWebSockets()
      .filter((socket) => (socket.deserializeAttachment() as Attachment).live);
  }
  private close(socket: WebSocket, reason?: string, cause = 'WS_CLOSED') {
    const attachment = socket.deserializeAttachment() as Attachment;
    console.info(
      JSON.stringify({
        event: 'room_lobby_closed',
        at: Date.now(),
        roomId: attachment.roomId,
        connectionId: attachment.connectionId,
        objectId: this.ctx.id.toString(),
        code: reason ?? cause,
        heartbeatAgeMs: Date.now() - attachment.lastSeen,
        reportReceived: attachment.reportReceived,
        clientReport: attachment.clientReport,
        sockets: this.sockets().length,
      }),
    );
    attachment.live = false;
    socket.serializeAttachment(attachment);
    try {
      socket.close(reason ? 1008 : 1000, reason ?? 'Closed');
    } catch {}
  }
  private sweep(room: UserRoom) {
    const now = Date.now();
    for (const socket of this.sockets())
      if (
        (socket.deserializeAttachment() as Attachment).lastSeen +
          runtime.connection.heartbeatTimeoutMs <=
        now
      )
        this.close(socket, undefined, 'HEARTBEAT_TIMEOUT');
    const connected = new Set(
      this.sockets().map(
        (socket) => (socket.deserializeAttachment() as Attachment).actorId,
      ),
    );
    for (const member of room.members) {
      member.connected = connected.has(member.id) && member.expires > now;
    }
    const host = room.members.find((member) => member.id === room.hostId);
    if (!host?.connected) {
      const next = room.members.find((member) => member.connected);
      if (next && next.id !== room.hostId) {
        room.hostId = next.id;
        room.settings.presenter = false;
        room.revision++;
        this.unready(room);
      }
    }
    if (connected.size) room.emptySince = undefined;
    else {
      room.emptySince ??= now;
      if (now >= room.emptySince + 600000) room.closed = true;
    }
  }
  private unready(room: UserRoom) {
    for (const member of room.members) member.ready = false;
  }
  private isPlaying(status: { phase: Snapshot['phase']; closed: boolean } | null) {
    return (
      !!status &&
      !(status.closed && status.phase === 'WAITING') &&
      !['FINISHED', 'INVALID'].includes(status.phase)
    );
  }
  private view(room: UserRoom, actor: string, playing = room.playing): RoomView {
    const member = room.members.find((candidateMember) => candidateMember.id === actor);
    return {
      id: room.id,
      instanceId: room.scope.id,
      settings: room.settings,
      password: !!room.password,
      revision: room.revision,
      hostId: room.hostId,
      hostName: room.members.find((member) => member.id === room.hostId)?.name ?? null,
      hostServerName: room.members.find((member) => member.id === room.hostId)
        ?.serverName,
      members: room.members.map(
        ({ id, name, serverName, guest, ready, joinedAt, connected }) => ({
          id,
          name,
          serverName,
          guest,
          ready,
          joinedAt,
          connected,
        }),
      ),
      closed: room.closed,
      playing,
      matchRoom:
        member && !member.inLobby && room.match?.actors.includes(actor)
          ? room.match.id
          : null,
      waiting: !!member && member.inLobby && playing,
      ...(actor === room.hostId ? { invite: room.invite } : {}),
    };
  }
  private broadcast(room: UserRoom) {
    for (const socket of this.sockets()) {
      const actor = (socket.deserializeAttachment() as Attachment).actorId;
      try {
        socket.send(JSON.stringify({ type: 'lobby', room: this.view(room, actor) }));
      } catch {
        this.close(socket, undefined, 'WS_SEND_FAILED');
      }
    }
  }
  private async save(
    room: UserRoom,
    receipts: Record<string, unknown> = {},
    remove: string[] = [],
  ) {
    const deadlines = this.sockets().map(
      (socket) =>
        (socket.deserializeAttachment() as Attachment).lastSeen +
        runtime.connection.heartbeatTimeoutMs,
    );
    if (!room.closed && room.emptySince !== undefined)
      deadlines.push(room.emptySince + 600000);
    if (room.childSessionExpires) deadlines.push(room.childSessionExpires);
    for (const member of room.members)
      if (!room.starting && (!room.playing || !room.match?.actors.includes(member.id)))
        deadlines.push(member.expires);
    if (room.starting) deadlines.push(Date.now() + runtime.connection.heartbeatTimeoutMs);
    const before = this.persisted.get(room);
    if (!before) throw new Error('ROOM_DATA_NOT_LOADED');
    await saveRoomData(this.env, room, before);
    this.persisted.set(room, roomData(room));
    if (room.closed) {
      this.broadcast(room);
      for (const socket of this.sockets()) this.close(socket, 'ROOM_CLOSED');
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.transaction(async (tx) => {
      await writeStored(tx, 'user-room', {
        id: room.id,
        instanceId: room.scope.id,
        playing: room.playing,
        emptySince: room.emptySince,
        childSessionExpires: room.childSessionExpires,
        match: room.match,
        starting: room.starting,
        members: room.members.map(({ id, generation, ready, inLobby }) => ({
          id,
          generation,
          ready,
          inLobby,
        })),
      } satisfies LiveRoom);
      for (const [key, value] of Object.entries(receipts))
        await writeStored(tx, key, value);
      for (const key of remove) await deleteStored(tx, key);
      if (deadlines.length) await tx.setAlarm(Math.min(...deadlines));
      else await tx.deleteAlarm();
    });
  }
}
