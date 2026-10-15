import { DurableObject } from 'cloudflare:workers';
import catalogConfig from '../../../config/matchmaking.json' with { type: 'json' };
import type { GameMessage, Reply, Snapshot } from '../../shared/game.ts';
import { settings } from '../../shared/settings.ts';
import { loadFixedVersion, loadMatchDefinition } from '../catalog/database.ts';
import { type MatchDefinition, validateDefinition } from '../catalog/definition.ts';
import { contentHash } from '../catalog/hash.ts';
import type { Env } from '../env.ts';
import { refreshParticipationAccess } from '../federation/participation.ts';
import { dispatchSavedResult } from '../federation/results.ts';
import { failureCode } from '../http/handlers.ts';
import {
  reservationLifetime,
  sessionLifetime,
  waitingLifetime,
} from '../matchmaking/config.ts';
import type { InstanceScope } from '../matchmaking/Matchmaker.ts';
import { allowedInstanceActors } from '../organization/database.ts';
import { registerInstanceRoom } from '../organization/rooms.ts';
import { rankingRating } from '../questions/ranking.ts';
import { ResultConflict, saveResult } from '../results/database.ts';
import type { Participant } from '../rooms/database.ts';
import { RoomLobby } from '../rooms/RoomLobby.ts';
import { roomRpc } from '../rooms/rpc.ts';
import { anonymizeState, expireReview, reviewDeadline } from './privacy.ts';
import { replayEvents } from './recovery.ts';
import { matchRoomName } from './room-names.ts';
import {
  adjudicate,
  advance,
  answeringPlayers,
  changed,
  commandFingerprint,
  createState,
  forfeitPlayer,
  questionEnded,
  type State,
  snapshot,
  updateConnections,
} from './state.ts';
import { readStored, writeStored } from './storage.ts';
import { parseCommand, parseSync } from './validation.ts';

type MatchRoom = {
  initialization?: string;
  scope: InstanceScope;
  generations: Record<string, string>;
  resultRetryAt?: number;
  resultErrorCode?: string;
  state: State;
  sessions: Record<string, string>;
  lobby: {
    expires: number;
    sessionExpires: number;
    reservations: Record<string, number>;
    closed: boolean;
  };
};
// The development game (/local-game/) has no instance, waiting lobby or saved result.
type DevelopmentRoom = {
  state: State;
  sessions: Record<string, string>;
  localSetup: { questionIndex: number };
};
type Room = MatchRoom | DevelopmentRoom;
const isMatchRoom = (room: Room): room is MatchRoom => !('localSetup' in room);
type Attachment = {
  actorId: string;
  windowStart: number;
  count: number;
  lastSeen: number;
  live: boolean;
  lastSeq: number | null;
};
const heartbeatTimeout = settings.connection.heartbeatTimeoutMs;

export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (env.PROBES_ENABLED === 'true' && env.ROOM_LIFECYCLE_LOGS === 'true')
      console.info(
        JSON.stringify({
          event: 'game_room_initialized',
          objectId: ctx.id.toString(),
          sockets: ctx.getWebSockets().length,
        }),
      );
  }
  private userLobby() {
    return new RoomLobby(this.ctx, this.env);
  }
  // Instance operations only address match rooms; a development room here is a routing error.
  private async readMatchRoom() {
    const room = await readStored<Room>(this.ctx.storage, 'room');
    if (room && !isMatchRoom(room)) throw new Error('DEVELOPMENT_ROOM');
    return room;
  }
  async createUserRoom(
    id: string,
    scope: InstanceScope,
    actor: Participant,
    input: Record<string, unknown>,
  ) {
    return roomRpc(() => this.userLobby().create(id, scope, actor, input));
  }
  async joinUserRoom(
    actor: Participant,
    token: string,
    generation: string,
    password: string,
    invite: string,
    scope: InstanceScope,
  ) {
    return this.userLobby().join(actor, token, generation, password, invite, scope);
  }
  async createdRoomInvite(actor: string) {
    const creation = await this.ctx.storage.get<{ actor: string; invite: string }>(
      'creation',
    );
    if (creation?.actor !== actor) throw new Error('ROOM_HOST_REQUIRED');
    return creation.invite;
  }
  async userRoomInfo(invite?: string) {
    return roomRpc(() => this.userLobby().info(invite));
  }
  async userRoomView(actor: string, token?: string) {
    return roomRpc(() => this.userLobby().viewFor(actor, token));
  }
  async userRoomOriginals(actor: string) {
    return roomRpc(() => this.userLobby().originals(actor));
  }
  async mutateUserRoom(actor: Participant, input: Record<string, unknown>) {
    return roomRpc(() => this.userLobby().mutate(actor, input));
  }
  async userRoomGameSession(actor: string, token: string) {
    return roomRpc(() => this.userLobby().gameSession(actor, token));
  }
  async initializeRoomMatch(
    definition: MatchDefinition,
    scope: InstanceScope,
    actors: (Participant & { role?: 'presenter' })[],
    tokens: Record<string, string>,
    parentRoomId?: string,
  ) {
    definition = await validateDefinition(definition);
    if (
      definition.kind !== 'room' ||
      scope.mode !== 'room' ||
      scope.owner !== definition.competition.owner ||
      new Set(actors.map((actor) => actor.id)).size !== actors.length ||
      actors.filter((actor) => actor.role !== 'presenter').length !==
        definition.playersPerMatch ||
      actors.filter((actor) => actor.role === 'presenter').length > 1 ||
      actors.some((actor) => !tokens[actor.id])
    )
      throw new Error('INVALID_SETUP');
    const initialization = await contentHash([
      scope,
      definition,
      actors,
      tokens,
      ...(parentRoomId ? [parentRoomId] : []),
    ]);
    const existing = await this.readMatchRoom();
    if (existing) {
      if (existing.initialization !== initialization)
        throw new Error('OPERATION_CONFLICT');
      return { ok: true as const };
    }
    await registerInstanceRoom(this.env, scope, this.ctx.id.toString(), false);
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('instanceDeleted'))
        throw new Error('INSTANCE_NOT_FOUND');
      const previous = await this.readMatchRoom();
      const sessions = Object.fromEntries(
        actors.map((actor) => [tokens[actor.id], actor.id]),
      );
      if (previous) {
        if (previous.scope.id !== scope.id || previous.initialization !== initialization)
          throw new Error('OPERATION_CONFLICT');
        return { ok: true as const };
      }
      const state = createState(
        definition.questions,
        0,
        definition.playersPerMatch,
        true,
        definition,
      );
      state.players = actors.map((actor) => ({
        ...actor,
        correct: 0,
        mistakes: 0,
        locked: false,
        disqualified: false,
        connected: false,
      }));
      if (parentRoomId) state.parentRoomId = parentRoomId;
      const room: MatchRoom = {
        initialization,
        scope,
        generations: {},
        state,
        sessions,
        lobby: {
          expires: Date.now() + waitingLifetime,
          sessionExpires: Date.now() + sessionLifetime,
          reservations: Object.fromEntries(
            actors.map((actor) => [actor.id, Date.now() + reservationLifetime]),
          ),
          closed: false,
        },
      };
      for (const actor of actors) {
        if (await this.ctx.storage.get(`revoked:${tokens[actor.id]}`)) {
          delete room.sessions[tokens[actor.id]];
          delete room.lobby.reservations[actor.id];
          room.state.players = room.state.players.filter(
            (player) => player.id !== actor.id,
          );
          room.lobby.closed = true;
        }
      }
      await this.save(room);
      return { ok: true as const };
    });
  }
  async reservationIdentity(actorId: string, token: string) {
    const room = await this.readMatchRoom();
    if (
      !room ||
      room.sessions[token] !== actorId ||
      room.lobby.closed ||
      Date.now() >= room.lobby.sessionExpires
    )
      throw new Error('STALE_RESERVATION');
    return { matchId: room.state.matchId, phase: room.state.phase };
  }
  async reserve(
    actorId: string,
    name: string,
    token: string,
    definition: MatchDefinition | undefined,
    scope: InstanceScope,
    generation: string,
    guest = false,
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('instanceDeleted'))
        return { ok: false as const, code: 'INSTANCE_NOT_FOUND' };
      if (
        (await this.ctx.storage.get(`closed:${generation}`)) ||
        (await this.ctx.storage.get(`revoked:${token}`))
      )
        return { ok: false as const, code: 'STALE_RESERVATION' };
      let room = await this.readMatchRoom();
      if (room && (room.scope.id !== scope.id || room.scope.owner !== scope.owner))
        return { ok: false as const, code: 'INSTANCE_MISMATCH' };
      if (definition && definition.competition.owner !== scope.owner)
        return { ok: false as const, code: 'INSTANCE_MISMATCH' };
      const now = Date.now();
      if (!room) {
        if (!definition) return { ok: false as const, code: 'ROOM_CLOSED' };
        const selection = await registerInstanceRoom(
          this.env,
          scope,
          this.ctx.id.toString(),
          false,
          definition.selection,
        );
        if (selection) definition = { ...definition, selection };
        room = {
          scope,
          generations: {},
          state: createState(
            definition.questions,
            0,
            definition.playersPerMatch,
            definition.rules.showSelections,
            definition,
          ),
          sessions: {},
          lobby: {
            expires: now + waitingLifetime,
            sessionExpires: now + sessionLifetime,
            reservations: {},
            closed: false,
          },
        };
      }
      if (
        room.state.phase === 'WAITING' &&
        !(await allowedInstanceActors(this.env, room.scope, [actorId])).includes(actorId)
      )
        return { ok: false as const, code: 'INSTANCE_NOT_FOUND' };
      if (room.generations[actorId] && room.generations[actorId] !== generation)
        return { ok: false as const, code: 'STALE_RESERVATION' };
      room.generations[actorId] = generation;
      await this.sweep(room, now);
      await this.save(room);
      if (room.lobby.closed || now >= room.lobby.sessionExpires)
        return { ok: false as const, code: 'ROOM_CLOSED' };
      if (room.state.players.some((player) => player.id === actorId)) {
        room.sessions[token] = actorId;
        await this.save(room);
        return { ok: true as const, expires: room.lobby.sessionExpires };
      }
      if (
        room.state.phase !== 'WAITING' ||
        room.state.players.length >= room.state.playersRequired
      )
        return { ok: false as const, code: 'ROOM_CLOSED' };
      room.sessions[token] = actorId;
      room.lobby.reservations[actorId] = now + reservationLifetime;
      room.state.players.push({
        id: actorId,
        name,
        ...(guest ? { guest: true } : {}),
        correct: 0,
        mistakes: 0,
        locked: false,
        disqualified: false,
        connected: false,
      });
      changed(room.state, now);
      await this.save(room);
      this.broadcast(room);
      return { ok: true as const, expires: room.lobby.sessionExpires };
    });
  }

  async lobbyStatus(): Promise<{
    phase: Snapshot['phase'];
    closed: boolean;
    actors: string[];
    capacity: number;
  } | null> {
    if (await this.userLobby().read()) return this.userLobby().status();
    await this.refreshForeignWaiting();
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.readMatchRoom();
      if (!room) return null;
      await this.checkWaitingAccess(room);
      await this.sweep(room, Date.now());
      advance(room.state, Date.now());
      await this.save(room);
      this.broadcast(room);
      return {
        phase: room.state.phase,
        closed: room.lobby.closed || Date.now() >= room.lobby.sessionExpires,
        actors: room.state.players.map((player) => player.id),
        capacity: room.state.playersRequired,
      };
    });
  }

  async deletionStatus(
    instanceId: string,
  ): Promise<{ safe: boolean; scope: InstanceScope | null }> {
    const parent = await this.userLobby().read();
    if (parent) {
      if (parent.scope.id !== instanceId) return { safe: false, scope: parent.scope };
      if (parent.starting) return { safe: false, scope: parent.scope };
      return parent.match
        ? this.env.GAME_ROOM.getByName(matchRoomName(parent.match.id)).deletionStatus(
            instanceId,
          )
        : { safe: true, scope: parent.scope };
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.readMatchRoom();
      if (!room) return { safe: true, scope: null };
      if (room.scope.id !== instanceId) return { safe: false, scope: room.scope };
      const finished = room.state.phase === 'FINISHED' || room.state.phase === 'INVALID';
      const safe =
        room.state.phase === 'WAITING' ||
        (finished &&
          (!room.state.completed || room.state.result?.storage === 'confirmed'));
      return { safe, scope: room.scope };
    });
  }

  async inventoryScope() {
    const parent = await this.userLobby().read();
    if (parent) return { instanceId: parent.scope.id, owner: parent.scope.owner };
    const room = await readStored<Room>(this.ctx.storage, 'room');
    if (!room || !isMatchRoom(room)) return null;
    return { instanceId: room.scope.id, owner: room.scope.owner };
  }

  async persistenceStatus(instanceId: string) {
    const room = await this.readMatchRoom();
    if (room?.scope.id !== instanceId) return null;
    return {
      phase: room.state.phase,
      matchId: room.state.matchId ?? null,
      storage: room.state.result?.storage ?? null,
      errorCode: room.resultErrorCode ?? null,
    };
  }

  async anonymizeAccount(actorId: string, questionIds: string[]) {
    if (await this.userLobby().read()) return this.userLobby().anonymize(actorId);
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (!room) return;
      anonymizeState(room.state, actorId, new Set(questionIds));
      changed(room.state, Date.now());
      await this.save(room);
      this.broadcast(room);
    });
  }

  async registerInventory(scope: InstanceScope) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const parent = await this.userLobby().read();
      if (parent) {
        if (parent.scope.id !== scope.id || parent.scope.owner !== scope.owner)
          throw new Error('INSTANCE_MISMATCH');
        await registerInstanceRoom(this.env, scope, this.ctx.id.toString(), true);
        return;
      }
      const room = await this.readMatchRoom();
      if (!room) return;
      if (room.scope.id !== scope.id || room.scope.owner !== scope.owner)
        throw new Error('INSTANCE_MISMATCH');
      await registerInstanceRoom(this.env, scope, this.ctx.id.toString(), true);
    });
  }

  async eraseInstance(instanceId: string) {
    if (await this.userLobby().read()) {
      const status = await this.deletionStatus(instanceId);
      if (!status.safe) return { ok: false as const, code: 'MATCH_STARTED' };
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const parent = await this.userLobby().read();
      if (parent) {
        if (parent.scope.id !== instanceId)
          return { ok: false as const, code: 'INSTANCE_MISMATCH' };
        if (parent.starting) return { ok: false as const, code: 'START_PENDING' };
        if (
          parent.match &&
          !(
            await this.env.GAME_ROOM.getByName(
              matchRoomName(parent.match.id),
            ).deletionStatus(instanceId)
          ).safe
        )
          return { ok: false as const, code: 'RESULT_PENDING' };
      }
      const room = await this.readMatchRoom();
      if (room) {
        if (room.scope.id !== instanceId)
          return { ok: false as const, code: 'INSTANCE_MISMATCH' };
        if (
          room.state.phase !== 'WAITING' &&
          !['FINISHED', 'INVALID'].includes(room.state.phase)
        )
          return { ok: false as const, code: 'MATCH_STARTED' };
        if (room.state.completed && room.state.result?.storage !== 'confirmed')
          return { ok: false as const, code: 'RESULT_PENDING' };
      }
      for (const socket of this.liveSockets())
        this.closeSocket(socket, 1008, 'INSTANCE_DELETED');
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put('instanceDeleted', instanceId);
      await this.ctx.storage.deleteAlarm();
      return { ok: true as const };
    });
  }

  async eraseRestoredInstance(receipt: { id: string; owner: string; deletedAt: string }) {
    // Only the maintenance service calls this with an independently preserved completion receipt.
    await this.ctx.blockConcurrencyWhile(async () => {
      const parent = await this.userLobby().read();
      if (
        parent &&
        (parent.scope.id !== receipt.id ||
          parent.scope.owner !== receipt.owner ||
          parent.createdAt > Date.parse(receipt.deletedAt))
      )
        throw new Error('RESTORED_ROOM_CONFLICT');
      const room = await this.readMatchRoom();
      if (
        room &&
        (room.scope.owner !== receipt.owner ||
          (room.state.startedAt ?? 0) > Date.parse(receipt.deletedAt))
      )
        throw new Error('RESTORED_ROOM_CONFLICT');
      for (const socket of this.liveSockets())
        this.closeSocket(socket, 1008, 'INSTANCE_DELETED');
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put('instanceDeleted', receipt.id);
      await this.ctx.storage.deleteAlarm();
    });
  }

  async stopWaiting(instanceId: string) {
    if (await this.userLobby().read()) return false;
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.readMatchRoom();
      if (!room || room.scope.id !== instanceId || room.state.phase !== 'WAITING')
        return false;
      room.lobby.closed = true;
      await this.save(room);
      for (const socket of this.liveSockets())
        this.closeSocket(socket, 1008, 'NO_RANKED_QUESTIONS');
      return true;
    });
  }

  async cancelReservation(
    actorId: string,
    revoke = false,
    generation?: string,
    token?: string,
    forfeit = false,
  ) {
    if (await this.userLobby().read())
      return this.userLobby().cancel(actorId, revoke, generation, token, forfeit);
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.readMatchRoom();
      if (
        room?.generations[actorId] &&
        generation &&
        room.generations[actorId] !== generation
      )
        return false;
      if (revoke && token) {
        if (!forfeit && (await this.ctx.storage.get(`revoked:${token}`))) return true;
        await this.ctx.storage.put(`revoked:${token}`, true);
      }
      if (!room) {
        if (generation) await this.ctx.storage.put(`closed:${generation}`, true);
        return true;
      }
      await this.sweep(room, Date.now());
      if (
        !revoke &&
        (room.state.phase === 'FINISHED' ||
          room.state.phase === 'INVALID' ||
          room.lobby.closed)
      ) {
        if (generation) await this.ctx.storage.put(`closed:${generation}`, true);
        await this.save(room);
        return true;
      }
      if (
        !revoke &&
        room.state.phase !== 'WAITING' &&
        room.state.players.some((player) => player.id === actorId)
      ) {
        await this.save(room);
        return false;
      }
      if ((!revoke || forfeit) && generation)
        await this.ctx.storage.put(`closed:${generation}`, true);
      for (const socket of this.liveSockets())
        if (this.attachment(socket).actorId === actorId)
          this.closeSocket(
            socket,
            1008,
            forfeit
              ? 'MATCH_REPLACED'
              : !revoke && room.state.phase === 'WAITING'
                ? 'WAITING_CANCELLED'
                : 'SESSION_REVOKED',
          );
      for (const [token, actor] of Object.entries(room.sessions))
        if (actor === actorId) {
          if (revoke) await this.ctx.storage.put(`revoked:${token}`, true);
          delete room.sessions[token];
        }
      if (room.state.phase === 'WAITING') {
        room.state.players = room.state.players.filter((player) => player.id !== actorId);
        delete room.lobby.reservations[actorId];
        delete room.generations[actorId];
      }
      if (forfeit) forfeitPlayer(room.state, actorId, Date.now());
      await this.sweep(room, Date.now());
      changed(room.state, Date.now());
      await this.save(room);
      this.broadcast(room);
      return true;
    });
  }

  private async checkWaitingAccess(room: MatchRoom, connectingActor?: string) {
    if (room.state.phase !== 'WAITING') return;
    const allowed = new Set(
      await allowedInstanceActors(
        this.env,
        room.scope,
        room.state.players.map((player) => player.id),
        room.state.parentRoomId ?? room.state.matchId,
        room.state.players
          .filter((player) => !player.connected && player.id !== connectingActor)
          .map((player) => player.id),
      ),
    );
    const denied = room.state.players.filter((player) => !allowed.has(player.id));
    if (!denied.length) return;
    for (const player of denied) {
      const generation = room.generations[player.id];
      if (generation) await this.ctx.storage.put(`closed:${generation}`, true);
      for (const [token, actor] of Object.entries(room.sessions)) {
        if (actor === player.id) delete room.sessions[token];
      }
      delete room.lobby.reservations[player.id];
      delete room.generations[player.id];
      for (const socket of this.liveSockets())
        if (this.attachment(socket).actorId === player.id)
          this.closeSocket(socket, 1008, 'INSTANCE_ACCESS_REVOKED');
    }
    room.state.players = room.state.players.filter((player) => allowed.has(player.id));
    changed(room.state, Date.now());
    await this.save(room);
    this.broadcast(room);
  }

  async join(
    input: {
      name: string;
      questionIndex: number;
      players: number;
      showSelections?: boolean;
    },
    token: string | undefined,
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      let room = await readStored<Room>(this.ctx.storage, 'room');
      if (room && isMatchRoom(room)) throw new Error('MATCH_ROOM');
      if (!room) {
        let definition: MatchDefinition;
        try {
          definition = await loadMatchDefinition(this.env, {
            owner: catalogConfig.owner,
            profile: this.env.GAME_CONFIG_PROFILE,
          });
        } catch {
          return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
        }
        if (!definition.questions[input.questionIndex])
          return { ok: false as const, code: 'INVALID_SETUP' };
        room = {
          state: createState(
            definition.questions,
            input.questionIndex,
            input.players,
            input.showSelections,
          ),
          sessions: {},
          localSetup: { questionIndex: input.questionIndex },
        };
      }
      const now = Date.now();
      await this.sweep(room, now);
      await this.save(room);
      this.broadcast(room);

      const existing =
        token && Object.hasOwn(room.sessions, token) ? room.sessions[token] : undefined;
      if (existing) {
        if (
          this.liveSockets().filter(
            (socket) => this.attachment(socket).actorId === existing,
          ).length >= settings.game.maxConnectionsPerActor
        )
          return { ok: false as const, code: 'CONNECTION_LIMIT' };
        return { ok: true as const, token: token as string };
      }
      if (
        room.state.phase !== 'WAITING' ||
        room.state.players.length >= room.state.playersRequired
      )
        return { ok: false as const, code: 'ROOM_CLOSED' };
      if (
        room.localSetup.questionIndex !== input.questionIndex ||
        room.state.playersRequired !== input.players ||
        room.state.rules.showSelections !== (input.showSelections ?? true)
      )
        return { ok: false as const, code: 'SETUP_MISMATCH' };

      const actorId = crypto.randomUUID();
      const session = crypto.randomUUID() + crypto.randomUUID();
      room.sessions[session] = actorId;
      room.state.players.push({
        id: actorId,
        name: input.name,
        correct: 0,
        mistakes: 0,
        locked: false,
        disqualified: false,
        connected: false,
      });
      changed(room.state, now);

      await this.save(room);
      this.broadcast(room);
      return { ok: true as const, token: session };
    });
  }

  async fetch(request: Request) {
    if (await this.userLobby().read()) return this.userLobby().fetch(request);
    await this.refreshForeignWaiting(true, request);
    let validation:
      | {
          matchId: string;
          actorKey: string;
          ratings?: Record<string, number>;
          result: { playersPerMatch: number; rulesHash: string } | string;
        }
      | undefined;
    for (;;) {
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
          return new Response(null, { status: 426 });

        const room = await readStored<Room>(this.ctx.storage, 'room');
        const session = request.headers.get('X-Game-Session') ?? '';
        const actorId =
          room && Object.hasOwn(room.sessions, session)
            ? room.sessions[session]
            : undefined;
        if (!room || !actorId) return new Response(null, { status: 401 });
        if (
          (request.headers.get('X-Game-Instance') ?? '') !==
          (isMatchRoom(room) ? room.scope.id : '')
        )
          return new Response(null, { status: 403 });

        let now = Date.now();
        await this.sweep(room, now);
        await this.save(room);
        if (isMatchRoom(room)) {
          if (
            room.lobby.closed ||
            now >= room.lobby.sessionExpires ||
            !room.sessions[session]
          )
            return new Response(null, { status: 401 });
          if (
            room.state.definition &&
            room.state.matchKind !== 'room' &&
            room.state.phase === 'WAITING' &&
            !room.state.players.find((player) => player.id === actorId)?.connected &&
            room.state.players.filter((player) => player.connected).length + 1 ===
              room.state.playersRequired
          ) {
            // DBの待機は直列化区間の外へ出す。戻ったら保存状態・認可・人数を再確認する。
            const actorKey = room.state.players
              .map((player) => player.id)
              .sort()
              .join(',');
            if (
              validation?.matchId !== room.state.matchId ||
              validation.actorKey !== actorKey
            )
              return {
                matchId: room.state.matchId,
                reference: room.state.definition.competition,
                actorKey,
                actors:
                  room.state.definition.selection && room.state.matchKind === 'ranked'
                    ? room.state.players.map((player) => player.id)
                    : [],
              };
            let code = typeof validation.result === 'string' ? validation.result : '';
            if (
              typeof validation.result !== 'string' &&
              (validation.result.rulesHash !== room.state.definition.rulesHash ||
                validation.result.playersPerMatch !== room.state.playersRequired)
            )
              code = 'DEFINITION_HASH_MISMATCH';
            if (code) {
              if (['DEFINITION_NOT_FOUND', 'DEFINITION_HASH_MISMATCH'].includes(code)) {
                room.lobby.closed = true;
                for (const socket of this.liveSockets())
                  this.closeSocket(socket, 1008, 'SETUP_UNAVAILABLE');
              }
              await this.save(room);
              return new Response(null, { status: 503 });
            }
          }

          await this.checkWaitingAccess(room, actorId);
        }
        if (!room.sessions[session]) return new Response(null, { status: 403 });
        if (
          this.liveSockets().filter(
            (socket) => this.attachment(socket).actorId === actorId,
          ).length >= settings.game.maxConnectionsPerActor
        )
          return new Response(null, { status: 429 });

        now = Date.now();
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [actorId]);
        pair[1].serializeAttachment({
          actorId,
          windowStart: now,
          count: 0,
          lastSeen: now,
          live: true,
          lastSeq: null,
        } satisfies Attachment);
        await this.sweep(room, now);

        if (
          room.state.phase === 'WAITING' &&
          answeringPlayers(room.state).filter(({ connected }) => connected).length ===
            room.state.playersRequired
        ) {
          if (room.state.definition?.selection && room.state.matchKind === 'ranked') {
            room.state.startingRatings = validation?.ratings;
          }
          room.state.startedAt = now;
          room.state.phase = 'REVEALING';
          room.state.deadline = now + room.state.rules.revealIntervalMs;
          changed(room.state, now);
        }
        advance(room.state, now);
        await this.save(room);
        this.broadcast(room);
        return new Response(null, { status: 101, webSocket: pair[0] });
      });
      if (result instanceof Response) return result;
      try {
        const [definition, entries] = await Promise.all([
          loadFixedVersion(this.env, result.reference),
          Promise.all(
            result.actors.map(
              async (actor) =>
                [
                  actor,
                  await rankingRating(this.env, result.reference.owner, actor),
                ] as const,
            ),
          ),
        ]);
        validation = {
          matchId: result.matchId,
          actorKey: result.actorKey,
          ratings: Object.fromEntries(entries),
          result: definition,
        };
      } catch (error) {
        validation = {
          matchId: result.matchId,
          actorKey: result.actorKey,
          result:
            error instanceof Error ? error.message || 'DB_UNAVAILABLE' : 'DB_UNAVAILABLE',
        };
      }
    }
  }

  private async refreshForeignWaiting(force = false, request?: Request) {
    const room = await readStored<Room>(this.ctx.storage, 'room');
    if (!room || !isMatchRoom(room)) return;
    if (
      request &&
      (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
        !room.sessions[request.headers.get('X-Game-Session') ?? ''] ||
        request.headers.get('X-Game-Instance') !== room.scope.id)
    )
      return;
    if (room.state.phase === 'WAITING')
      await refreshParticipationAccess(
        this.env,
        room.scope.id,
        room.state.players.map((player) => player.id),
        force,
        room.state.parentRoomId ? undefined : room.state.matchId,
        false,
        room.state.parentRoomId,
      );
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (await this.userLobby().read()) return this.userLobby().message(socket, message);
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (!room) {
        socket.close(1008, 'SESSION_INVALID');
        return;
      }

      const now = Date.now();
      await this.sweep(room, now);
      const attachment = this.attachment(socket);
      if (!attachment.live) {
        await this.save(room);
        this.broadcast(room);
        return;
      }
      if (now - attachment.windowStart >= settings.game.commandRateWindowMs) {
        attachment.windowStart = now;
        attachment.count = 0;
      }
      attachment.count++;
      attachment.lastSeen = now;
      socket.serializeAttachment(attachment);

      if (attachment.count > settings.game.commandsPerWindow) {
        this.closeSocket(socket, 1008, 'RATE_LIMIT');
        await this.sweep(room, now);
        await this.save(room);
        this.broadcast(room);
        return;
      }

      const sync = parseSync(message);
      if (sync) {
        advance(room.state, now);
        await this.save(room);
        this.sendState(socket, room, sync.lastSeq, sync.matchId);
        this.broadcast(room);
        return;
      }

      const command = parseCommand(message);
      if (!command) {
        await this.save(room);
        this.broadcast(room);
        this.send(socket, { type: 'error', code: 'INVALID_COMMAND' });
        return;
      }

      const key = `command:${attachment.actorId}:${command.commandId}`;
      const previous =
        room.state.matchKind === 'room'
          ? await this.ctx.storage.get<{ fingerprint: string; reply: Reply }>(key)
          : undefined;
      const fingerprint = commandFingerprint(command);
      const reply: Reply = previous
        ? previous.fingerprint === fingerprint
          ? previous.reply
          : {
              commandId: command.commandId,
              ok: false,
              code: 'COMMAND_CONFLICT',
              roomSeq: room.state.roomSeq,
            }
        : adjudicate(room.state, attachment.actorId, command, now);
      await this.save(
        room,
        room.state.matchKind === 'room' && !previous
          ? { key, value: { fingerprint, reply } }
          : undefined,
      );
      this.send(socket, { type: 'ack', reply });
      this.broadcast(room);
    });
  }

  async expireReview() {
    if (await this.userLobby().read()) return this.userLobby().alarm();
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (room && expireReview(room.state, Date.now())) await this.save(room);
    });
  }

  async alarm() {
    if (await this.userLobby().read()) return this.userLobby().alarm();
    const pending = await this.ctx.blockConcurrencyWhile(async () => {
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (!room) return;

      await this.sweep(room, Date.now());
      advance(room.state, Date.now());
      await this.save(room);
      this.broadcast(room);
      if (
        !isMatchRoom(room) ||
        room.state.result?.storage !== 'pending' ||
        !room.state.completed ||
        (room.resultRetryAt ?? 0) > Date.now()
      )
        return;
      room.resultRetryAt = Date.now() + settings.results.retryIntervalMs;
      await this.save(room);
      return { owner: room.scope.owner, record: room.state.completed };
    });
    if (!pending) return;

    // DB待機中も再接続・同期を処理する。DOと再試行Alarmは先に保存済み。
    let status: 'confirmed' | 'conflict';
    try {
      await saveResult(this.env, pending.owner, pending.record);
      status = 'confirmed';
    } catch (error) {
      if (!(error instanceof ResultConflict)) {
        await this.ctx.blockConcurrencyWhile(async () => {
          const room = await this.readMatchRoom();
          if (!room || room.state.matchId !== pending.record.matchId) return;
          room.resultErrorCode = failureCode(error);
          if (room.resultErrorCode === 'CPU_LIMIT')
            room.resultRetryAt = Date.now() + 60000;
          await this.save(room);
        });
        return;
      }
      status = 'conflict';
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.readMatchRoom();
      if (
        !room ||
        room.state.matchId !== pending.record.matchId ||
        room.state.result?.storage !== 'pending'
      )
        return;
      room.state.result.storage = status;
      delete room.resultRetryAt;
      delete room.resultErrorCode;
      changed(room.state, Date.now());
      await this.save(room);
      this.broadcast(room);
    });
    if (status === 'confirmed')
      this.ctx.waitUntil(
        dispatchSavedResult(this.env, pending.record.matchId).catch((error) => {
          console.error(
            JSON.stringify({
              event: 'federation_result_dispatch_failed',
              code: failureCode(error),
            }),
          );
        }),
      );
  }

  async webSocketClose(socket: WebSocket) {
    await this.disconnect(socket);
  }
  async webSocketError(socket: WebSocket) {
    await this.disconnect(socket);
  }

  private async disconnect(socket: WebSocket) {
    if (await this.userLobby().read()) return this.userLobby().disconnect(socket);
    await this.ctx.blockConcurrencyWhile(async () => {
      this.closeSocket(socket, 1000, 'Closed');
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (!room) return;

      await this.sweep(room, Date.now());
      await this.save(room);
      this.broadcast(room);
    });
  }

  private attachment(socket: WebSocket): Attachment {
    return socket.deserializeAttachment() as Attachment;
  }

  private liveSockets() {
    return this.ctx.getWebSockets().filter((socket) => this.attachment(socket).live);
  }

  private closeSocket(socket: WebSocket, code: number, reason: string) {
    const attachment = this.attachment(socket);
    attachment.live = false;
    socket.serializeAttachment(attachment);
    try {
      socket.close(code, reason);
    } catch {
      /* 切断済みでも在席更新を続ける。 */
    }
  }

  private async sweep(room: Room, now: number) {
    for (const socket of this.liveSockets()) {
      if (now >= this.attachment(socket).lastSeen + heartbeatTimeout)
        this.closeSocket(socket, 1000, 'HEARTBEAT_TIMEOUT');
    }
    if (isMatchRoom(room)) {
      if (
        now >= room.lobby.sessionExpires ||
        (room.state.phase === 'WAITING' && now >= room.lobby.expires)
      )
        room.lobby.closed = true;
      if (room.lobby.closed) {
        for (const socket of this.liveSockets())
          this.closeSocket(socket, 1008, 'WAITING_EXPIRED');
      } else if (room.state.phase === 'WAITING') {
        const connected = new Set(
          this.liveSockets().map((socket) => this.attachment(socket).actorId),
        );
        for (const player of [...room.state.players]) {
          if (connected.has(player.id)) room.lobby.reservations[player.id] = 0;
          else if (
            room.lobby.reservations[player.id] === 0 &&
            room.state.matchKind === 'room'
          )
            room.lobby.reservations[player.id] = now + reservationLifetime;
          else if (
            room.lobby.reservations[player.id] === 0 ||
            now >= room.lobby.reservations[player.id]
          ) {
            const generation = room.generations[player.id];
            if (generation) await this.ctx.storage.put(`closed:${generation}`, true);
            if (room.state.definition?.kind === 'room') room.lobby.closed = true;
            room.state.players = room.state.players.filter(
              (item) => item.id !== player.id,
            );
            delete room.lobby.reservations[player.id];
            delete room.generations[player.id];
            for (const [token, actor] of Object.entries(room.sessions))
              if (actor === player.id) delete room.sessions[token];
            changed(room.state, now);
          }
        }
      }
    }
    updateConnections(
      room.state,
      new Set(this.liveSockets().map((socket) => this.attachment(socket).actorId)),
      now,
    );
  }

  private async save(
    room: Room,
    receipt?: { key: string; value: { fingerprint: string; reply: Reply } },
  ) {
    expireReview(room.state, Date.now());
    if (
      isMatchRoom(room) &&
      room.state.result?.storage === 'pending' &&
      room.resultRetryAt === undefined
    )
      room.resultRetryAt = Date.now();
    await this.ctx.storage.transaction(async (tx) => {
      await writeStored(tx, 'room', room);
      if (receipt) await tx.put(receipt.key, receipt.value);
      const deadlines = this.liveSockets().map(
        (socket) => this.attachment(socket).lastSeen + heartbeatTimeout,
      );
      const reviewAt = reviewDeadline(room.state);
      if (reviewAt !== undefined) deadlines.push(reviewAt);
      if (isMatchRoom(room)) {
        if (!room.lobby.closed) {
          deadlines.push(room.lobby.sessionExpires);
          if (room.state.phase === 'WAITING') {
            deadlines.push(room.lobby.expires);
            deadlines.push(
              ...Object.values(room.lobby.reservations).filter(
                (deadline) => deadline > 0,
              ),
            );
          }
        }
        if (room.state.result?.storage === 'pending' && room.resultRetryAt !== undefined)
          deadlines.push(room.resultRetryAt);
      }
      if (room.state.reconnect) deadlines.push(room.state.reconnect.deadline);
      else if (
        room.state.deadline !== null &&
        !(
          room.state.phase === 'JUDGED' &&
          questionEnded(room.state) &&
          room.state.players.some(
            (player) => player.role === 'presenter' && player.connected,
          )
        )
      )
        deadlines.push(room.state.deadline);
      if (deadlines.length) await tx.setAlarm(Math.min(...deadlines));
      else await tx.deleteAlarm();
    });
  }

  private send(socket: WebSocket, message: GameMessage) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      socket.close(1011, 'Send failed');
    }
  }

  private sendState(
    socket: WebSocket,
    room: Room,
    lastSeq: number | null = null,
    matchId: string | null = null,
  ) {
    const attachment = this.attachment(socket);
    const now = Date.now();
    const common = {
      actorId: attachment.actorId,
      serverTime: now,
      panel: room.state.holder === attachment.actorId ? room.state.panel : null,
    };
    const events =
      lastSeq !== null && matchId === room.state.matchId
        ? replayEvents(room.state.events, room.state.roomSeq, lastSeq, now)
        : null;

    if (events)
      this.send(socket, {
        type: 'delta',
        ...common,
        matchId: room.state.matchId,
        fromSeq: lastSeq as number,
        roomSeq: room.state.roomSeq,
        events,
      });
    else this.send(socket, { type: 'state', ...common, snapshot: snapshot(room.state) });
    attachment.lastSeq = room.state.roomSeq;
    socket.serializeAttachment(attachment);
  }

  private broadcast(room: Room) {
    for (const socket of this.liveSockets()) {
      const attachment = this.attachment(socket);
      // 最初のsyncでクライアントの保持位置を受け取ってから配信する。
      if (attachment.lastSeq !== null && attachment.lastSeq !== room.state.roomSeq)
        this.sendState(socket, room, attachment.lastSeq, room.state.matchId);
    }
  }
}
