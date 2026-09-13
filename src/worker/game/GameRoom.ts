import { DurableObject } from 'cloudflare:workers';
import type { GameMessage } from '../../shared/game';
import type { Env } from '../env';
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

type Room = { state: State; sessions: Record<string, string> };
type Attachment = {
  actorId: string;
  windowStart: number;
  count: number;
  lastSeen: number;
  live: boolean;
  lastSeq: number | null;
};
const heartbeatTimeout = 15000;

export class GameRoom extends DurableObject<Env> {
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
      const room = (await this.ctx.storage.get<Room>('room')) ?? {
        state: createState(input.questionIndex, input.players, input.showSelections),
        sessions: {},
      };
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
          ).length >= 3
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
        room.state.questions[0].id !==
          `mock-${String(input.questionIndex + 1).padStart(2, '0')}` ||
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
    return this.ctx.blockConcurrencyWhile(async () => {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return new Response(null, { status: 426 });

      const room = await this.ctx.storage.get<Room>('room');
      const session = request.headers.get('X-Game-Session') ?? '';
      const actorId =
        room && Object.hasOwn(room.sessions, session)
          ? room.sessions[session]
          : undefined;
      if (!room || !actorId) return new Response(null, { status: 401 });

      const now = Date.now();
      this.sweep(room, now);
      await this.save(room);
      if (
        this.liveSockets().filter((socket) => this.attachment(socket).actorId === actorId)
          .length >= 3
      )
        return new Response(null, { status: 429 });

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
      if (now - attachment.windowStart >= 1000) {
        attachment.windowStart = now;
        attachment.count = 0;
      }
      attachment.count++;
      attachment.lastSeen = now;
      socket.serializeAttachment(attachment);

      if (attachment.count > 20) {
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
