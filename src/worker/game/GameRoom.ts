import { DurableObject } from 'cloudflare:workers';
import type { GameMessage, Reply, Snapshot } from '../../shared/game';
import { settings } from '../../shared/settings';
import { loadMatchDefinition } from '../catalog/database';
import { type MatchDefinition, validateDefinition } from '../catalog/definition';
import { contentHash } from '../catalog/hash';
import type { Env } from '../env';
import {
  reservationLifetime,
  sessionLifetime,
  waitingLifetime,
} from '../matchmaking/config';
import type { InstanceScope } from '../matchmaking/Matchmaker';
import { allowedInstanceActors } from '../organization/database';
import { registerInstanceRoom } from '../organization/rooms';
import { rankingRating } from '../questions/ranking';
import { ResultConflict, saveResult } from '../results/database';
import type { Participant } from '../rooms/database';
import { RoomLobby } from '../rooms/RoomLobby';
import { roomRpc } from '../rooms/rpc';
import { anonymizeState, expireReview, reviewDeadline } from './privacy';
import { replayEvents } from './recovery';
import {
  adjudicate,
  advance,
  answeringPlayers,
  changed,
  commandFingerprint,
  createState,
  questionEnded,
  type State,
  snapshot,
  updateConnections,
} from './state';
import { readStored, writeStored } from './storage';
import { parseCommand, parseSync } from './validation';

type Room = {
  initialization?: string;
  registered?: boolean;
  scope?: InstanceScope;
  generations?: Record<string, string>;
  resultRetryAt?: number;
  state: State;
  sessions: Record<string, string>;
  localSetup?: { questionIndex: number };
  lobby?: {
    expires: number;
    sessionExpires: number;
    reservations: Record<string, number>;
    closed: boolean;
  };
};
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
  private userLobby() {
    return new RoomLobby(this.ctx, this.env);
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
    scope?: InstanceScope,
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
  ) {
    definition = await validateDefinition(definition);
    if (
      definition.kind !== 'room' ||
      scope.mode !== 'room' ||
      scope.owner !== definition.competition.owner ||
      new Set(actors.map((a) => a.id)).size !== actors.length ||
      actors.filter((a) => a.role !== 'presenter').length !==
        definition.playersPerMatch ||
      actors.filter((a) => a.role === 'presenter').length > 1 ||
      actors.some((a) => !tokens[a.id])
    )
      throw new Error('INVALID_SETUP');
    const initialization = await contentHash([scope, definition, actors, tokens]);
    const existing = await readStored<Room>(this.ctx.storage, 'room');
    if (existing) {
      if (existing.initialization !== initialization)
        throw new Error('OPERATION_CONFLICT');
      return { ok: true as const };
    }
    await registerInstanceRoom(this.env, scope, this.ctx.id.toString(), false);
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('instanceDeleted'))
        throw new Error('INSTANCE_NOT_FOUND');
      const previous = await readStored<Room>(this.ctx.storage, 'room');
      const sessions = Object.fromEntries(actors.map((a) => [tokens[a.id], a.id]));
      if (previous) {
        if (previous.scope?.id !== scope.id || previous.initialization !== initialization)
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
      state.players = actors.map((a) => ({
        ...a,
        correct: 0,
        mistakes: 0,
        locked: false,
        disqualified: false,
        connected: false,
      }));
      const room: Room = {
        initialization,
        registered: true,
        scope,
        state,
        sessions,
        lobby: {
          expires: Date.now() + waitingLifetime,
          sessionExpires: Date.now() + sessionLifetime,
          reservations: Object.fromEntries(
            actors.map((a) => [a.id, Date.now() + reservationLifetime]),
          ),
          closed: false,
        },
      };
      for (const actor of actors) {
        if (await this.ctx.storage.get(`revoked:${tokens[actor.id]}`)) {
          delete room.sessions[tokens[actor.id]];
          delete room.lobby?.reservations[actor.id];
          room.state.players = room.state.players.filter((p) => p.id !== actor.id);
          if (room.lobby) room.lobby.closed = true;
        }
      }
      await this.save(room);
      return { ok: true as const };
    });
  }
  async reserve(
    actorId: string,
    name: string,
    token: string,
    definition?: MatchDefinition,
    scope?: InstanceScope,
    generation?: string,
    guest = false,
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('instanceDeleted'))
        return { ok: false as const, code: 'INSTANCE_NOT_FOUND' };
      if (
        (generation && (await this.ctx.storage.get(`closed:${generation}`))) ||
        (await this.ctx.storage.get(`revoked:${token}`))
      )
        return { ok: false as const, code: 'STALE_RESERVATION' };
      let room = await readStored<Room>(this.ctx.storage, 'room');
      if (room && (room.scope?.id !== scope?.id || room.scope?.owner !== scope?.owner))
        return { ok: false as const, code: 'INSTANCE_MISMATCH' };
      if (scope && definition && definition.competition.owner !== scope.owner)
        return { ok: false as const, code: 'INSTANCE_MISMATCH' };
      const now = Date.now();
      if (!room) {
        if (!definition) return { ok: false as const, code: 'ROOM_CLOSED' };
        if (scope) {
          const selection = await registerInstanceRoom(
            this.env,
            scope,
            this.ctx.id.toString(),
            false,
            definition.selection,
          );
          if (selection) definition = { ...definition, selection };
        }
        room = {
          registered: !!scope,
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
      if (!room.lobby) return { ok: false as const, code: 'ROOM_CLOSED' };
      if (
        room.scope &&
        room.state.phase === 'WAITING' &&
        !(await allowedInstanceActors(this.env, room.scope, [actorId])).includes(actorId)
      )
        return { ok: false as const, code: 'INSTANCE_NOT_FOUND' };
      room.generations ??= {};
      if (
        generation &&
        room.generations[actorId] &&
        room.generations[actorId] !== generation
      )
        return { ok: false as const, code: 'STALE_RESERVATION' };
      if (generation) room.generations[actorId] = generation;
      this.sweep(room, now);
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
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (!room?.lobby) return null;
      await this.checkWaitingAccess(room);
      this.sweep(room, Date.now());
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
        ? this.env.GAME_ROOM.getByName(`1c:${parent.match.id}`).deletionStatus(instanceId)
        : { safe: true, scope: parent.scope };
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (!room) return { safe: true, scope: null };
      if (room.scope?.id !== instanceId)
        return { safe: false, scope: room.scope ?? null };
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
    if (!room) return null;
    return {
      instanceId: room.scope?.id ?? null,
      owner: room.scope?.owner ?? room.state.definition?.competition.owner ?? null,
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
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (!room) return;
      if (
        (room.scope && room.scope.id !== scope.id) ||
        (room.scope?.owner ?? room.state.definition?.competition.owner) !== scope.owner
      )
        throw new Error('INSTANCE_MISMATCH');
      await registerInstanceRoom(this.env, scope, this.ctx.id.toString(), true);
      const mode =
        room.scope?.mode ??
        (room.state.matchKind === 'room' || room.state.matchKind === 'casual'
          ? room.state.matchKind
          : scope.mode);
      room.scope = { ...scope, mode };
      room.registered = true;
      await this.ctx.storage.transaction((tx) => writeStored(tx, 'room', room));
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
            await this.env.GAME_ROOM.getByName(`1c:${parent.match.id}`).deletionStatus(
              instanceId,
            )
          ).safe
        )
          return { ok: false as const, code: 'RESULT_PENDING' };
      }
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (room) {
        if (room.scope?.id !== instanceId)
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
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (
        room &&
        ((room.scope?.owner ?? room.state.definition?.competition.owner) !==
          receipt.owner ||
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
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (!room?.lobby || room.scope?.id !== instanceId || room.state.phase !== 'WAITING')
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
  ) {
    if (await this.userLobby().read())
      return this.userLobby().cancel(actorId, revoke, generation, token);
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (
        room?.generations?.[actorId] &&
        generation &&
        room.generations[actorId] !== generation
      )
        return false;
      if (revoke && token) {
        if (await this.ctx.storage.get(`revoked:${token}`)) return true;
        await this.ctx.storage.put(`revoked:${token}`, true);
      }
      if (!room?.lobby) {
        if (generation) await this.ctx.storage.put(`closed:${generation}`, true);
        return true;
      }
      this.sweep(room, Date.now());
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
        room.state.players.some((p) => p.id === actorId)
      ) {
        await this.save(room);
        return false;
      }
      if (!revoke && generation) await this.ctx.storage.put(`closed:${generation}`, true);
      for (const socket of this.liveSockets())
        if (this.attachment(socket).actorId === actorId)
          this.closeSocket(socket, 1008, 'SESSION_REVOKED');
      for (const [token, actor] of Object.entries(room.sessions))
        if (actor === actorId) {
          if (revoke) await this.ctx.storage.put(`revoked:${token}`, true);
          delete room.sessions[token];
        }
      if (room.state.phase === 'WAITING') {
        room.state.players = room.state.players.filter((player) => player.id !== actorId);
        delete room.lobby.reservations[actorId];
        if (room.generations) delete room.generations[actorId];
      }
      this.sweep(room, Date.now());
      changed(room.state, Date.now());
      await this.save(room);
      this.broadcast(room);
      return true;
    });
  }

  private async checkWaitingAccess(room: Room) {
    if (!room.scope || !room.lobby || room.state.phase !== 'WAITING') return;
    const allowed = new Set(
      await allowedInstanceActors(
        this.env,
        room.scope,
        room.state.players.map((player) => player.id),
      ),
    );
    const denied = room.state.players.filter((player) => !allowed.has(player.id));
    if (!denied.length) return;
    for (const player of denied) {
      const generation = room.generations?.[player.id];
      if (generation) await this.ctx.storage.put(`closed:${generation}`, true);
      for (const [token, actor] of Object.entries(room.sessions)) {
        if (actor === player.id) delete room.sessions[token];
      }
      delete room.lobby.reservations[player.id];
      if (room.generations) delete room.generations[player.id];
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
      if (!room) {
        let definition: MatchDefinition;
        try {
          definition = await loadMatchDefinition(this.env);
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
      this.sweep(room, now);
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
        (room.localSetup
          ? room.localSetup.questionIndex !== input.questionIndex
          : room.state.questions[0].id !==
            `mock-${String(input.questionIndex + 1).padStart(2, '0')}`) ||
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
    let validation:
      | {
          matchId: string;
          actorKey: string;
          ratings?: Record<string, number>;
          result: MatchDefinition | string;
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
        if ((request.headers.get('X-Game-Instance') ?? '') !== (room.scope?.id ?? ''))
          return new Response(null, { status: 403 });

        let now = Date.now();
        this.sweep(room, now);
        await this.save(room);
        if (
          room.lobby &&
          (room.lobby.closed ||
            now >= room.lobby.sessionExpires ||
            !room.sessions[session])
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
              validation.result.manifestHash !== room.state.definition.manifestHash ||
              validation.result.playersPerMatch !== room.state.playersRequired)
          )
            code = 'DEFINITION_HASH_MISMATCH';
          if (code) {
            if (
              [
                'NO_RANKED_QUESTIONS',
                'QUESTION_UNAVAILABLE',
                'DEFINITION_NOT_FOUND',
                'DEFINITION_HASH_MISMATCH',
                'INVALID_RULES',
                'INVALID_QUESTION',
                'INVALID_CHOICES',
                'INVALID_DEFINITION',
              ].includes(code) &&
              room.lobby
            ) {
              room.lobby.closed = true;
              for (const socket of this.liveSockets())
                this.closeSocket(
                  socket,
                  1008,
                  code === 'NO_RANKED_QUESTIONS' ? code : 'SETUP_UNAVAILABLE',
                );
            }
            await this.save(room);
            return new Response(null, { status: 503 });
          }
        }

        await this.checkWaitingAccess(room);
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
        this.sweep(room, now);

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
          loadMatchDefinition(this.env, result.reference),
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

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (await this.userLobby().read()) return this.userLobby().message(socket, message);
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (!room) {
        socket.close(1008, 'SESSION_INVALID');
        return;
      }

      const now = Date.now();
      this.sweep(room, now);
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
        this.sweep(room, now);
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
    let resultOwner = this.env.GAME_OWNER;
    const pending = await this.ctx.blockConcurrencyWhile(async () => {
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (!room) return;

      this.sweep(room, Date.now());
      advance(room.state, Date.now());
      await this.save(room);
      this.broadcast(room);
      if (
        room.state.result?.storage !== 'pending' ||
        !room.state.completed ||
        (room.resultRetryAt ?? 0) > Date.now()
      )
        return;
      room.resultRetryAt = Date.now() + settings.results.retryIntervalMs;
      await this.save(room);
      resultOwner = room.scope?.owner ?? this.env.GAME_OWNER;
      return room.state.completed;
    });
    if (!pending) return;

    // DB待機中も再接続・同期を処理する。DOと再試行Alarmは先に保存済み。
    let status: 'confirmed' | 'conflict';
    try {
      await saveResult({ ...this.env, GAME_OWNER: resultOwner }, pending);
      status = 'confirmed';
    } catch (error) {
      if (!(error instanceof ResultConflict)) return;
      status = 'conflict';
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await readStored<Room>(this.ctx.storage, 'room');
      if (
        !room ||
        room.state.result?.id !== pending.result.id ||
        room.state.result.storage !== 'pending'
      )
        return;
      room.state.result.storage = status;
      delete room.resultRetryAt;
      changed(room.state, Date.now());
      await this.save(room);
      this.broadcast(room);
    });
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

      this.sweep(room, Date.now());
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

  private sweep(room: Room, now: number) {
    for (const socket of this.liveSockets()) {
      if (now >= this.attachment(socket).lastSeen + heartbeatTimeout)
        this.closeSocket(socket, 1000, 'HEARTBEAT_TIMEOUT');
    }
    if (room.lobby) {
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
          else if (room.lobby.reservations[player.id] === 0)
            room.lobby.reservations[player.id] = now + reservationLifetime;
          else if (now >= room.lobby.reservations[player.id]) {
            if (room.state.definition?.kind === 'room') room.lobby.closed = true;
            room.state.players = room.state.players.filter(
              (item) => item.id !== player.id,
            );
            delete room.lobby.reservations[player.id];
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
    if (room.scope && !room.registered) {
      await registerInstanceRoom(this.env, room.scope, this.ctx.id.toString(), true);
      room.registered = true;
    }
    if (room.state.result?.storage === 'pending' && room.resultRetryAt === undefined)
      room.resultRetryAt = Date.now();
    await this.ctx.storage.transaction(async (tx) => {
      await writeStored(tx, 'room', room);
      if (receipt) await tx.put(receipt.key, receipt.value);
      const deadlines = this.liveSockets().map(
        (socket) => this.attachment(socket).lastSeen + heartbeatTimeout,
      );
      const reviewAt = reviewDeadline(room.state);
      if (reviewAt !== undefined) deadlines.push(reviewAt);
      if (room.lobby && !room.lobby.closed) {
        deadlines.push(room.lobby.sessionExpires);
        if (room.state.phase === 'WAITING') {
          deadlines.push(room.lobby.expires);
          deadlines.push(
            ...Object.values(room.lobby.reservations).filter((deadline) => deadline > 0),
          );
        }
      }
      if (room.state.result?.storage === 'pending' && room.resultRetryAt !== undefined)
        deadlines.push(room.resultRetryAt);
      if (room.state.reconnect) deadlines.push(room.state.reconnect.deadline);
      else if (
        room.state.deadline !== null &&
        !(
          room.state.phase === 'JUDGED' &&
          questionEnded(room.state) &&
          room.state.players.some((p) => p.role === 'presenter' && p.connected)
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
