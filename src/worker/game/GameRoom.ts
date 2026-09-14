import { DurableObject } from 'cloudflare:workers';
import type { GameMessage } from '../../shared/game';
import { settings } from '../../shared/settings';
import { loadMatchDefinition } from '../catalog/database';
import type { MatchDefinition } from '../catalog/definition';
import type { Env } from '../env';
import {
  reservationLifetime,
  sessionLifetime,
  waitingLifetime,
} from '../matchmaking/config';
import { replayEvents } from './recovery';
import {
  adjudicate,
  advance,
  changed,
  createState,
  type State,
  snapshot,
  updateConnections,
} from './state';
import { parseCommand, parseSync } from './validation';

type Room = {
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
  async reserve(
    actorId: string,
    name: string,
    token: string,
    definition?: MatchDefinition,
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      let room = await this.ctx.storage.get<Room>('room');
      const now = Date.now();
      if (!room) {
        if (!definition) return { ok: false as const, code: 'ROOM_CLOSED' };
        room = {
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

  async lobbyStatus() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.ctx.storage.get<Room>('room');
      if (!room?.lobby) return null;
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

  async cancelReservation(actorId: string, revoke = false) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.ctx.storage.get<Room>('room');
      if (!room?.lobby) return true;
      this.sweep(room, Date.now());
      if (!revoke && room.state.phase !== 'WAITING' && !room.lobby.closed) {
        await this.save(room);
        return false;
      }
      for (const socket of this.liveSockets())
        if (this.attachment(socket).actorId === actorId)
          this.closeSocket(socket, 1008, 'SESSION_REVOKED');
      for (const [token, actor] of Object.entries(room.sessions))
        if (actor === actorId) delete room.sessions[token];
      if (room.state.phase === 'WAITING') {
        room.state.players = room.state.players.filter((player) => player.id !== actorId);
        delete room.lobby.reservations[actorId];
      }
      this.sweep(room, Date.now());
      changed(room.state, Date.now());
      await this.save(room);
      this.broadcast(room);
      return true;
    });
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
      let room = await this.ctx.storage.get<Room>('room');
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
    let validation: { matchId: string; result: MatchDefinition | string } | undefined;
    for (;;) {
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
          return new Response(null, { status: 426 });

        const room = await this.ctx.storage.get<Room>('room');
        const session = request.headers.get('X-Game-Session') ?? '';
        const actorId =
          room && Object.hasOwn(room.sessions, session)
            ? room.sessions[session]
            : undefined;
        if (!room || !actorId) return new Response(null, { status: 401 });

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
          room.state.phase === 'WAITING' &&
          !room.state.players.find((player) => player.id === actorId)?.connected &&
          room.state.players.filter((player) => player.connected).length + 1 ===
            room.state.playersRequired
        ) {
          // DBの待機は直列化区間の外へ出す。戻ったら保存状態・認可・人数を再確認する。
          if (validation?.matchId !== room.state.matchId)
            return {
              matchId: room.state.matchId,
              reference: room.state.definition.competition,
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
                this.closeSocket(socket, 1008, 'SETUP_UNAVAILABLE');
            }
            await this.save(room);
            return new Response(null, { status: 503 });
          }
        }

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
          room.state.players.filter(({ connected }) => connected).length ===
            room.state.playersRequired
        ) {
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
        validation = {
          matchId: result.matchId,
          result: await loadMatchDefinition(this.env, result.reference),
        };
      } catch (error) {
        validation = {
          matchId: result.matchId,
          result:
            error instanceof Error ? error.message || 'DB_UNAVAILABLE' : 'DB_UNAVAILABLE',
        };
      }
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.ctx.storage.get<Room>('room');
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

      const reply = adjudicate(room.state, attachment.actorId, command, now);
      await this.save(room);
      this.send(socket, { type: 'ack', reply });
      this.broadcast(room);
    });
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.ctx.storage.get<Room>('room');
      if (!room) return;

      this.sweep(room, Date.now());
      advance(room.state, Date.now());
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
    await this.ctx.blockConcurrencyWhile(async () => {
      this.closeSocket(socket, 1000, 'Closed');
      const room = await this.ctx.storage.get<Room>('room');
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

  private async save(room: Room) {
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put('room', room);
      const deadlines = this.liveSockets().map(
        (socket) => this.attachment(socket).lastSeen + heartbeatTimeout,
      );
      if (room.lobby && !room.lobby.closed) {
        deadlines.push(room.lobby.sessionExpires);
        if (room.state.phase === 'WAITING') {
          deadlines.push(room.lobby.expires);
          deadlines.push(
            ...Object.values(room.lobby.reservations).filter((deadline) => deadline > 0),
          );
        }
      }
      if (room.state.reconnect) deadlines.push(room.state.reconnect.deadline);
      else if (room.state.deadline !== null) deadlines.push(room.state.deadline);
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
